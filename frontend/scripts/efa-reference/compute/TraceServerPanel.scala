import java.io.{DataInputStream, DataOutputStream, EOFException}
import java.nio.{ByteBuffer, ByteOrder}
import dev.ludovic.netlib.blas.BLAS

/** Benchmark-only pair-tiled construction preserving the original row-major
  * BLAS inputs. Bounded row codes and a small pair working set improve locality.
  * This is a local stdin/stdout child, not a network or production service. */
object TraceServerPanel {
  def main(args: Array[String]): Unit = {
    require(args.isEmpty, "Unknown argument")
    val rowCache = true
    val blas = BLAS.getInstance()
    val backend = blas.getClass.getName
    require(backend.contains("JNI"), "Native BLAS is unavailable: " + backend)
    System.err.println(s"""{"ready":true,"backend":"$backend","java":"${System.getProperty("java.runtime.version")}","nativeLibPath":"${System.getProperty("dev.ludovic.netlib.blas.nativeLibPath", "library default")}","replyHeaderDoubles":3,"reuseBuffers":true,"rowCodeCache":$rowCache,"matrixLayout":"row-major","pairTile":256,"maxBlockRows":256,"cancellationProbe":true}""")
    val in = new DataInputStream(System.in)
    val out = new DataOutputStream(System.out)
    var totalRows = 0; var sourcePairs = 0; var sourceParameters = 0; var items = 0
    var codes = Array.emptyShortArray; var meta = Array.emptyIntArray
    var lookup = Array.emptyDoubleArray; var projection = Array.emptyDoubleArray
    var firstItem = Array.emptyIntArray; var secondItem = Array.emptyIntArray
    var rowCodes = Array.emptyIntArray
    var leftStart = -1; var leftRows = 0; var rightStart = -1; var rightRows = 0
    var leftA = Array.emptyDoubleArray; var leftZ = Array.emptyDoubleArray
    var rightA = Array.emptyDoubleArray; var rightZ = Array.emptyDoubleArray
    var values = Array.emptyDoubleArray
    var response = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
    def capacity(array: Array[Double], size: Int): Array[Double] = if (array.length >= size) array else new Array[Double](size)
    def materialize(start: Int, rows: Int, a: Array[Double], z: Array[Double]): Unit = {
      require(start >= 0 && rows > 0 && rows <= 256 && start + rows <= totalRows, "Invalid resident row range")
      var row = 0
      while (row < rows) {
        var item = 0
        while (item < items) {
          rowCodes(row * items + item) = codes(item * totalRows + start + row).toInt & 0xffff
          item += 1
        }
        row += 1
      }
      var first = 0
      while (first < sourcePairs) {
        val end = math.min(sourcePairs, first + 256)
        row = 0
        while (row < rows) {
          val codeOffset = row * items; val destination = row * sourcePairs
          var pair = first
          while (pair < end) {
            val x = rowCodes(codeOffset + firstItem(pair)); val y = rowCodes(codeOffset + secondItem(pair))
            a(destination + pair) = if (x == 65535 || y == 65535) 0.0 else lookup(meta(pair * 4 + 3) + x * meta(pair * 4 + 2) + y)
            pair += 1
          }
          row += 1
        }
        first = end
      }
      System.arraycopy(projection, start * sourceParameters, z, 0, rows * sourceParameters)
    }
    def reply(size: Int, started: Long, materializeMs: Double, blasMs: Double): Unit = {
      val elapsedMs = (System.nanoTime() - started) / 1e6
      val length = 24 + size * 8
      if (response.capacity() < length) response = ByteBuffer.allocate(length).order(ByteOrder.LITTLE_ENDIAN)
      response.clear(); response.putDouble(elapsedMs); response.putDouble(materializeMs); response.putDouble(blasMs)
      var i = 0
      while (i < size) { response.putDouble(values(i)); i += 1 }
      out.writeInt(length); out.write(response.array(), 0, length); out.flush()
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
          items = cells / totalRows
          codes = Array.fill(cells)(input.getShort()); meta = Array.fill(sourcePairs * 4)(input.getInt())
          lookup = Array.fill(entries)(input.getDouble()); projection = Array.fill(totalRows * sourceParameters)(input.getDouble())
          firstItem = new Array[Int](sourcePairs); secondItem = new Array[Int](sourcePairs)
          var pair = 0
          while (pair < sourcePairs) {
            require(meta(pair * 4) >= 0 && meta(pair * 4 + 1) >= 0 && meta(pair * 4) % totalRows == 0 && meta(pair * 4 + 1) % totalRows == 0)
            firstItem(pair) = meta(pair * 4) / totalRows; secondItem(pair) = meta(pair * 4 + 1) / totalRows
            require(firstItem(pair) < items && secondItem(pair) < items)
            pair += 1
          }
          rowCodes = new Array[Int](256 * items)
          leftStart = -1; rightStart = -1; leftRows = 0; rightRows = 0
          leftA = Array.emptyDoubleArray; leftZ = Array.emptyDoubleArray
          rightA = Array.emptyDoubleArray; rightZ = Array.emptyDoubleArray
          out.writeInt(8); out.write(new Array[Byte](8)); out.flush()
        } else if (magic == 0x45464133 || magic == 0x45464134) {
          require(length == 20 && totalRows > 0, "Resident source not initialized")
          val left = input.getInt(); val right = input.getInt(); val rows = input.getInt(); val cols = input.getInt()
          require(rows > 0 && cols > 0 && rows <= 256 && cols <= 256 && left >= 0 && right >= 0 && left + rows <= totalRows && right + cols <= totalRows)
          val started = System.nanoTime()
          if (leftStart != left || leftRows != rows) {
            leftA = capacity(leftA, rows * sourcePairs); leftZ = capacity(leftZ, rows * sourceParameters)
            materialize(left, rows, leftA, leftZ); leftStart = left; leftRows = rows
          }
          val diagonal = left == right && rows == cols
          if (!diagonal && (rightStart != right || rightRows != cols)) {
            rightA = capacity(rightA, cols * sourcePairs); rightZ = capacity(rightZ, cols * sourceParameters)
            materialize(right, cols, rightA, rightZ); rightStart = right; rightRows = cols
          }
          val b = if (diagonal) leftA else rightA; val zb = if (diagonal) leftZ else rightZ
          values = capacity(values, rows * cols)
          val beforeBlas = System.nanoTime()
          blas.dgemm("T", "N", cols, rows, sourcePairs, 1.0, b, sourcePairs, leftA, sourcePairs, 0.0, values, cols)
          blas.dgemm("T", "N", cols, rows, sourceParameters, -1.0, zb, sourceParameters, leftZ, sourceParameters, 1.0, values, cols)
          if (magic == 0x45464134) {
            // A separate post-measurement cancellation workload. It cannot
            // finish normally before the host terminates it. The deadline
            // prevents an orphan probe from running indefinitely if the host dies.
            System.err.println("""{"probeDispatched":true}""")
            val deadline = System.nanoTime() + 5000000000L
            while (System.nanoTime() < deadline) {
              blas.dgemm("T", "N", cols, rows, sourcePairs, 1.0, b, sourcePairs, leftA, sourcePairs, 0.0, values, cols)
              blas.dgemm("T", "N", cols, rows, sourceParameters, -1.0, zb, sourceParameters, leftZ, sourceParameters, 1.0, values, cols)
            }
            throw new IllegalStateException("Cancellation probe was not terminated within five seconds")
          }
          reply(rows * cols, started, (beforeBlas - started) / 1e6, (System.nanoTime() - beforeBlas) / 1e6)
        } else {
          require(magic == 0x45464131 && length >= 24, "Invalid benchmark magic")
          val rows = input.getInt(); val cols = input.getInt(); val pairs = input.getInt(); val parameters = input.getInt(); input.getInt()
          require(rows > 0 && cols > 0 && rows <= 256 && cols <= 256 && pairs > 0 && parameters > 0)
          require(length.toLong == 24L + 8L * (rows + cols) * (pairs + parameters), "Invalid payload length")
          def array(n: Int): Array[Double] = Array.fill(n)(input.getDouble())
          val a = array(rows * pairs); val b = array(cols * pairs); val za = array(rows * parameters); val zb = array(cols * parameters)
          values = capacity(values, rows * cols)
          val started = System.nanoTime()
          blas.dgemm("T", "N", cols, rows, pairs, 1.0, b, pairs, a, pairs, 0.0, values, cols)
          blas.dgemm("T", "N", cols, rows, parameters, -1.0, zb, parameters, za, parameters, 1.0, values, cols)
          reply(rows * cols, started, 0.0, (System.nanoTime() - started) / 1e6)
        }
      }
    } catch { case _: EOFException => () }
  }
}
