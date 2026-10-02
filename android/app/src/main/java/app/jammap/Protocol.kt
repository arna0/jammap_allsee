package app.jammap

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor

/** Wire format. Must match server/src/shared.js and programs/jammap/src/lib.rs byte for byte. */
object Protocol {
    const val KIND_JAMMING = 1
    const val KIND_SPOOFING = 2

    const val CELL_DEG = 0.05
    private const val LON_CELLS = 7200L // 360 / CELL_DEG

    private val REPORT_DOMAIN = "jammap:report:v1".toByteArray(Charsets.US_ASCII)
    private val REGISTER_DOMAIN = "jammap:register:v1".toByteArray(Charsets.US_ASCII)
    private val HEARTBEAT_DOMAIN = "jammap:heartbeat:v1".toByteArray(Charsets.US_ASCII)

    fun cellId(lat: Double, lon: Double): Long {
        val latIdx = floor((lat + 90) / CELL_DEG).toLong()
        val lonIdx = floor((lon + 180) / CELL_DEG).toLong()
        return latIdx * LON_CELLS + lonIdx
    }

    /** REPORT_DOMAIN || cell u64 LE || ts i64 LE || kind u8 || severity u8 = 34 bytes */
    fun reportMessage(cell: Long, ts: Long, kind: Int, severity: Int): ByteArray =
        ByteBuffer.allocate(REPORT_DOMAIN.size + 18).order(ByteOrder.LITTLE_ENDIAN)
            .put(REPORT_DOMAIN).putLong(cell).putLong(ts).put(kind.toByte()).put(severity.toByte())
            .array()

    fun registerMessage(owner: ByteArray): ByteArray = REGISTER_DOMAIN + owner

    fun heartbeatMessage(ts: Long): ByteArray =
        ByteBuffer.allocate(HEARTBEAT_DOMAIN.size + 8).order(ByteOrder.LITTLE_ENDIAN)
            .put(HEARTBEAT_DOMAIN).putLong(ts).array()
}

object Base58 {
    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    fun encode(input: ByteArray): String {
        if (input.isEmpty()) return ""
        var zeros = 0
        while (zeros < input.size && input[zeros].toInt() == 0) zeros++
        val digits = input.copyOf()
        val out = CharArray(input.size * 2)
        var outStart = out.size
        var start = zeros
        while (start < digits.size) {
            var rem = 0
            for (i in start until digits.size) {
                val num = rem * 256 + (digits[i].toInt() and 0xff)
                digits[i] = (num / 58).toByte()
                rem = num % 58
            }
            out[--outStart] = ALPHABET[rem]
            while (start < digits.size && digits[start].toInt() == 0) start++
        }
        repeat(zeros) { out[--outStart] = '1' }
        return String(out, outStart, out.size - outStart)
    }

    fun decode(input: String): ByteArray {
        if (input.isEmpty()) return ByteArray(0)
        val bytes = ByteArray(input.length)
        var len = 0
        for (c in input) {
            var carry = ALPHABET.indexOf(c)
            require(carry >= 0) { "invalid base58 character '$c'" }
            for (j in 0 until len) {
                carry += (bytes[j].toInt() and 0xff) * 58
                bytes[j] = (carry and 0xff).toByte()
                carry = carry shr 8
            }
            while (carry > 0) {
                bytes[len++] = (carry and 0xff).toByte()
                carry = carry shr 8
            }
        }
        var zeros = 0
        while (zeros < input.length && input[zeros] == '1') zeros++
        return ByteArray(zeros) + bytes.copyOf(len).reversedArray()
    }
}
