import java.io.{DataInputStream, DataOutputStream, EOFException}
import java.nio.{ByteBuffer, ByteOrder}
import dev.ludovic.netlib.blas.BLAS

/** Local child-process benchmark protocol, not a network server. All frames
  * are bounded case blocks. Stdout carries binary replies, stderr metadata. */
object TraceServer {
  def main(args: Array[String]): Unit = {
    val blas = BLAS.getInstance()
    val backend = blas.getClass.getName
    require(backend.contains("JNI"), "Native BLAS is unavailable: " + backend)
    System.err.println(s"""{"ready":true,"backend":"$backend","java":"${System.getProperty("java.runtime.version")}","nativeLibPath":"${System.getProperty("dev.ludovic.netlib.blas.nativeLibPath", "library default")}"}""")
    val in = new DataInputStream(System.in)
    val out = new DataOutputStream(System.out)
    var totalRows = 0; var sourcePairs = 0; var sourceParameters = 0
    var codes = Array.emptyShortArray; var meta = Array.emptyIntArray
    var lookup = Array.emptyDoubleArray; var projection = Array.emptyDoubleArray
    var cachedStart = -1; var cachedRows = 0
    var cachedA = Array.emptyDoubleArray; var cachedZ = Array.emptyDoubleArray
    def materialize(start: Int, rows: Int): (Array[Double], Array[Double]) = {
      require(start >= 0 && rows > 0 && rows <= 128 && start + rows <= totalRows, "Invalid resident row range")
      val a = new Array[Double](rows * sourcePairs)
      var row = 0
      while (row < rows) {
        var pair = 0
        while (pair < sourcePairs) {
          val x = codes(meta(pair * 4) + start + row).toInt & 0xffff
          val y = codes(meta(pair * 4 + 1) + start + row).toInt & 0xffff
          if (x != 65535 && y != 65535) a(row * sourcePairs + pair) = lookup(meta(pair * 4 + 3) + x * meta(pair * 4 + 2) + y)
          pair += 1
        }
        row += 1
      }
      (a, java.util.Arrays.copyOfRange(projection, start * sourceParameters, (start + rows) * sourceParameters))
    }
    try {
      while (true) {
        val length = in.readInt()
        require(length >= 20 && length <= 512 * 1024 * 1024, "Invalid block frame size")
        val bytes = new Array[Byte](length); in.readFully(bytes)
        val input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val magic = input.getInt()
        if (magic == 0x45464132) {
          totalRows = input.getInt(); val cells = input.getInt(); sourcePairs = input.getInt(); sourceParameters = input.getInt(); val entries = input.getInt()
          require(totalRows > 0 && cells > 0 && cells % totalRows == 0 && sourcePairs > 0 && sourceParameters > 0 && entries > 0)
          require(length.toLong == 24L + cells * 2L + sourcePairs * 16L + entries * 8L + totalRows.toLong * sourceParameters * 8L)
          codes = Array.fill(cells)(input.getShort()); meta = Array.fill(sourcePairs * 4)(input.getInt())
          lookup = Array.fill(entries)(input.getDouble()); projection = Array.fill(totalRows * sourceParameters)(input.getDouble())
          cachedStart = -1; cachedA = Array.emptyDoubleArray; cachedZ = Array.emptyDoubleArray
          out.writeInt(8); out.write(new Array[Byte](8)); out.flush()
        } else if (magic == 0x45464133) {
          require(length == 20 && totalRows > 0, "Resident source not initialized")
          val left = input.getInt(); val right = input.getInt(); val rows = input.getInt(); val cols = input.getInt()
          val started = System.nanoTime()
          if (cachedStart != left || cachedRows != rows) { val pair = materialize(left, rows); cachedA = pair._1; cachedZ = pair._2; cachedStart = left; cachedRows = rows }
          val (b, zb) = if (left == right && rows == cols) (cachedA, cachedZ) else materialize(right, cols)
          val values = new Array[Double](rows * cols)
          blas.dgemm("T", "N", cols, rows, sourcePairs, 1.0, b, sourcePairs, cachedA, sourcePairs, 0.0, values, cols)
          blas.dgemm("T", "N", cols, rows, sourceParameters, -1.0, zb, sourceParameters, cachedZ, sourceParameters, 1.0, values, cols)
          val response = ByteBuffer.allocate(8 + values.length * 8).order(ByteOrder.LITTLE_ENDIAN)
          response.putDouble((System.nanoTime() - started) / 1e6); values.foreach(response.putDouble)
          out.writeInt(response.capacity()); out.write(response.array()); out.flush()
        } else {
        require(magic == 0x45464131, "Invalid benchmark magic")
        val rows = input.getInt(); val cols = input.getInt()
        val pairs = input.getInt(); val parameters = input.getInt(); input.getInt()
        require(rows > 0 && cols > 0 && rows <= 128 && cols <= 128 && pairs > 0 && parameters > 0)
        require(length.toLong == 24L + 8L * (rows + cols) * (pairs + parameters), "Invalid payload length")
        def array(n: Int): Array[Double] = Array.fill(n)(input.getDouble())
        val a = array(rows * pairs); val b = array(cols * pairs)
        val za = array(rows * parameters); val zb = array(cols * parameters)
        val values = new Array[Double](rows * cols)
        val started = System.nanoTime()
        blas.dgemm("T", "N", cols, rows, pairs, 1.0, b, pairs, a, pairs, 0.0, values, cols)
        blas.dgemm("T", "N", cols, rows, parameters, -1.0, zb, parameters, za, parameters, 1.0, values, cols)
        val elapsedMs = (System.nanoTime() - started) / 1e6
        val response = ByteBuffer.allocate(8 + values.length * 8).order(ByteOrder.LITTLE_ENDIAN)
        response.putDouble(elapsedMs); values.foreach(response.putDouble)
        out.writeInt(response.capacity()); out.write(response.array()); out.flush()
        }
      }
    } catch { case _: EOFException => () }
  }
}
