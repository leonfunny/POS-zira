package pl.zira.tvads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import pl.zira.tvads.discovery.SubnetScanner

class SubnetScannerTest {
    @Test fun subnetPrefix_validIpv4() {
        assertEquals("192.168.0.", SubnetScanner.subnetPrefix("192.168.0.23"))
        assertEquals("10.0.5.", SubnetScanner.subnetPrefix("10.0.5.1"))
    }

    @Test fun subnetPrefix_rejectsGarbage() {
        assertNull(SubnetScanner.subnetPrefix("not-an-ip"))
        assertNull(SubnetScanner.subnetPrefix("192.168.0"))
        assertNull(SubnetScanner.subnetPrefix("fe80::1"))
        assertNull(SubnetScanner.subnetPrefix("a.b.c.d"))
    }

    @Test fun localIpv4_doesNotThrow() {
        // Environment-dependent result; just assert the call is safe.
        SubnetScanner.localIpv4()
    }
}
