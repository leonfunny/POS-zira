package com.ziraai.posdiagnostics.dev;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ExampleUnitTest {

    @Test
    public void usesDevelopmentNamespace() {
        assertEquals("com.ziraai.posdiagnostics.dev", getClass().getPackage().getName());
    }
}
