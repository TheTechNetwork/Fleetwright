package network.thetech.fleetwright

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.DataInputStream

/**
 * The frame layer XoLink speaks to Xen Orchestra with, which is written here
 * rather than taken from a library (XoLink's header says why), so nothing else
 * would catch a length encoded wrong: a message over 125 or 65535 bytes is the
 * ordinary size of a pool's VM list, and a server that cannot read the length
 * closes the connection with no word as to why.
 */
class XoLinkTest {

    private fun read(bytes: ByteArray) = XoLink.readFrame(DataInputStream(ByteArrayInputStream(bytes)))

    @Test
    fun `a server that understood the upgrade answers the key the way RFC 6455 says`() {
        // The worked example in RFC 6455, section 1.3.
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", XoLink.accept("dGhlIHNhbXBsZSBub25jZQ=="))
    }

    @Test
    fun `a frame this phone sends is masked and reads back as what was sent, at every length encoding`() {
        for (size in listOf(0, 125, 126, 65535, 65536)) {
            val payload = ByteArray(size) { (it % 251).toByte() }
            val wire = XoLink.frame(0x1, payload)
            assertTrue("size $size is not masked", (wire[1].toInt() and 0x80) != 0)
            val f = read(wire)!!
            assertTrue(f.fin)
            assertEquals(0x1, f.opcode)
            assertArrayEquals("size $size", payload, f.payload)
        }
    }

    @Test
    fun `a server's unmasked frame reads as it is, and the end of the stream is no frame`() {
        val text = "{\"jsonrpc\":\"2.0\",\"method\":\"all\"}".toByteArray()
        val f = read(XoLink.frame(0x1, text, mask = false))!!
        assertArrayEquals(text, f.payload)
        assertNull(read(ByteArray(0)))
    }

    @Test
    fun `a frame claiming more than the client accepts is refused before it is read`() {
        // 127 says a 64-bit length follows; this one is one byte over the bound.
        val over = (XoLink.MAX_MESSAGE_BYTES + 1).toLong()
        val head = byteArrayOf(0x81.toByte(), 127) + ByteArray(8) { i -> ((over shr (56 - 8 * i)) and 0xff).toByte() }
        val refused = runCatching { read(head) }.exceptionOrNull()
        assertTrue(refused is XoLink.Failure)
    }

    @Test
    fun `an address is a host and a port the way setup records it`() {
        assertEquals("xo.lan" to 443, XoLink.splitAddress("xo.lan"))
        assertEquals("xo.lan" to 8443, XoLink.splitAddress("xo.lan:8443"))
        assertEquals("fe80::1" to 443, XoLink.splitAddress("[fe80::1]"))
        assertEquals("fe80::1" to 8443, XoLink.splitAddress("[fe80::1]:8443"))
    }

    @Test
    fun `the end of the headers is found wherever the blank line falls`() {
        val head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nrest".toByteArray()
        assertEquals(head.size - 8, XoLink.headerEnd(head))
        assertEquals(-1, XoLink.headerEnd("HTTP/1.1 101\r\n".toByteArray()))
    }
}
