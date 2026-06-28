package pl.zira.tvads.net

import org.json.JSONObject
import pl.zira.tvads.model.TvAppUpdate

object TvAppUpdateParser {
    fun parse(json: String): TvAppUpdate {
        val o = JSONObject(json)
        return TvAppUpdate(
            latestVersionCode = o.getInt("latestVersionCode"),
            latestVersionName = o.getString("latestVersionName"),
            apkUrl = if (o.isNull("apkUrl")) null else o.getString("apkUrl"),
            apkSize = if (o.isNull("apkSize")) null else o.getLong("apkSize"),
            apkSha256 = if (o.isNull("apkSha256")) null else o.getString("apkSha256"),
        )
    }
}
