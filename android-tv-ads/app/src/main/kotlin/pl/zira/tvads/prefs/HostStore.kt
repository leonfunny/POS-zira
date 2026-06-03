package pl.zira.tvads.prefs

import android.content.Context

class HostStore(context: Context) {
    private val prefs = context.getSharedPreferences("zira_tv_ads", Context.MODE_PRIVATE)
    var lastBase: String?
        get() = prefs.getString("lastBase", null)
        set(value) { prefs.edit().putString("lastBase", value).apply() }
}
