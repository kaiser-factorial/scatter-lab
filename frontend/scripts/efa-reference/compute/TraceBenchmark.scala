import java.nio.{ByteBuffer, ByteOrder}
import java.nio.file.{Files, Paths}
import java.security.MessageDigest
import dev.ludovic.netlib.blas.BLAS

/** Same bounded H = A B' - ZA ZB' operation as trace-kernel.ts.
  * No respondent data, server, or Spark runtime is part of this executable. */
object TraceBenchmark {
  def main(args: Array[String]): Unit = {
    require(args.length >= 3, "TraceBenchmark input.bin output.bin loop|blas [repetitions]")
    val started = System.nanoTime()
    val data = Files.readAllBytes(Paths.get(args(0)))
    val input = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
    require(input.getInt() == 0x45464131, "Invalid benchmark input")
    val rows = input.getInt(); val cols = input.getInt()
    val pairs = input.getInt(); val parameters = input.getInt(); val diagonal = input.getInt() == 1
    require(rows > 0 && cols > 0 && rows <= 128 && cols <= 128 && pairs > 0 && parameters > 0, "Invalid dimensions")
    require(data.length.toLong == 24L + 8L * (rows + cols) * (pairs + parameters), "Invalid payload length")
    def array(size: Int): Array[Double] = Array.fill(size)(input.getDouble())
    val a = array(rows * pairs); val b = array(cols * pairs)
    val za = array(rows * parameters); val zb = array(cols * parameters)
    val readMs = (System.nanoTime() - started) / 1e6
    val mode = args(2)
    require(mode == "loop" || mode == "blas", "Unknown backend")
    val blas = if (mode == "blas") Some(BLAS.getInstance()) else None
    val backend = blas.map(_.getClass.getName).getOrElse("scala-compensated-double-loop")
    if (mode == "blas") require(backend.contains("JNI"), "Native BLAS was requested but unavailable: " + backend)
    def calculate(): Array[Double] = {
      // Row-major H is the column-major transpose B A'.
      val out = new Array[Double](rows * cols)
      if (mode == "blas") {
        blas.get.dgemm("T", "N", cols, rows, pairs, 1.0, b, pairs, a, pairs, 0.0, out, cols)
        blas.get.dgemm("T", "N", cols, rows, parameters, -1.0, zb, parameters, za, parameters, 1.0, out, cols)
      } else {
        var row = 0
        while (row < rows) {
          var col = 0
          while (col < cols) {
            if (!diagonal || col <= row) {
              var sum = 0.0; var correction = 0.0; var k = 0
              while (k < pairs) {
                val term = a(row * pairs + k) * b(col * pairs + k) - correction
                val next = sum + term; correction = next - sum - term; sum = next; k += 1
              }
              k = 0
              while (k < parameters) { sum -= za(row * parameters + k) * zb(col * parameters + k); k += 1 }
              out(row * cols + col) = sum
            }
            col += 1
          }
          row += 1
        }
      }
      out
    }
    val repeats = if (args.length > 3) args(3).toInt else 5
    require(repeats > 0 && repeats <= 100)
    var result = Array.emptyDoubleArray
    val times = (0 until repeats).map { _ => val begin = System.nanoTime(); result = calculate(); (System.nanoTime() - begin) / 1e6 }
    val output = ByteBuffer.allocate(result.length * 8).order(ByteOrder.LITTLE_ENDIAN)
    result.foreach(output.putDouble)
    Files.write(Paths.get(args(1)), output.array())
    val sha = MessageDigest.getInstance("SHA-256").digest(data).map(b => f"${b & 0xff}%02x").mkString
    val runtime = System.getProperty("java.runtime.version")
    println(s"""{"backend":"$backend","precision":"float64","scala":"2.13.16","java":"$runtime","inputSha256":"$sha","rows":$rows,"cols":$cols,"pairs":$pairs,"parameters":$parameters,"readMs":$readMs,"kernelMs":[${times.mkString(",")}],"processBodyMs":${(System.nanoTime()-started)/1e6},"availableProcessors":${Runtime.getRuntime.availableProcessors()},"maxHeapBytes":${Runtime.getRuntime.maxMemory()}}""")
  }
}
