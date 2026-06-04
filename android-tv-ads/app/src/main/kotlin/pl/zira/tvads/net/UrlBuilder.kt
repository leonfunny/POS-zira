package pl.zira.tvads.net

object UrlBuilder {
    /** base = "http://host:port" (no trailing slash), rel = "/video/x". */
    fun absolute(base: String, rel: String): String =
        base.trimEnd('/') + (if (rel.startsWith("/")) rel else "/$rel")
}
