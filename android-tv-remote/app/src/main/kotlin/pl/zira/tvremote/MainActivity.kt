package pl.zira.tvremote

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private lateinit var setupPanel: LinearLayout
    private lateinit var urlInput: EditText
    private lateinit var statusText: TextView
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val prefs by lazy { getSharedPreferences("zira-tv-remote", Context.MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        webView.settings.allowContentAccess = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false
            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
                setupPanel.visibility = View.GONE
                webView.visibility = View.VISIBLE
                statusText.text = "Connected"
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                return try {
                    val intent = fileChooserParams.createIntent().apply {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        type = "*/*"
                        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(
                            "image/jpeg",
                            "image/png",
                            "image/webp",
                            "video/mp4",
                            "video/quicktime",
                        ))
                    }
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                    true
                } catch (_: Exception) {
                    fileChooserCallback = null
                    false
                }
            }
        }

        val incoming = remoteUrlFromIntent(intent)
        val saved = prefs.getString(KEY_REMOTE_URL, null)
        val initial = normalizeRemoteUrl(incoming ?: saved.orEmpty())
        if (initial != null) {
            urlInput.setText(initial)
            openRemote(initial)
        } else {
            showSetup("Scan/copy the Phone remote link from POS TV Ads settings.")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val url = normalizeRemoteUrl(remoteUrlFromIntent(intent).orEmpty())
        if (url != null) {
            urlInput.setText(url)
            openRemote(url)
        }
    }

    override fun onBackPressed() {
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
            return
        }
        if (webView.visibility == View.VISIBLE) {
            showSetup("Remote is saved. Tap Connect to reopen.")
            return
        }
        super.onBackPressed()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_CHOOSER_REQUEST) return
        val callback = fileChooserCallback ?: return
        fileChooserCallback = null
        if (resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return
        }
        callback.onReceiveValue(extractUris(data))
    }

    private fun buildUi() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(247, 248, 250))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(10))
            setBackgroundColor(Color.rgb(247, 248, 250))
        }
        header.addView(TextView(this).apply {
            text = "Zira TV Remote"
            textSize = 22f
            setTextColor(Color.rgb(21, 25, 34))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        statusText = TextView(this).apply {
            text = "Ready"
            textSize = 13f
            setTextColor(Color.rgb(102, 112, 133))
        }
        header.addView(statusText)
        root.addView(header)

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            visibility = View.GONE
            isIndeterminate = true
        }
        root.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(4),
        ))

        setupPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(18), dp(16), dp(16))
            gravity = Gravity.CENTER_HORIZONTAL
        }
        setupPanel.addView(TextView(this).apply {
            text = "Paste the Phone remote link from POS Settings > TV Ads. It looks like http://192.168.x.x:17893/remote?token=..."
            textSize = 15f
            setTextColor(Color.rgb(52, 64, 84))
        })
        urlInput = EditText(this).apply {
            hint = "http://POS-IP:17893/remote?token=..."
            setSingleLine(true)
            setTextColor(Color.rgb(21, 25, 34))
            setHintTextColor(Color.rgb(102, 112, 133))
        }
        setupPanel.addView(urlInput, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(14) })

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        row.addView(Button(this).apply {
            text = "Paste"
            setOnClickListener { pasteClipboard() }
        }, LinearLayout.LayoutParams(0, dp(48), 1f).apply { rightMargin = dp(8) })
        row.addView(Button(this).apply {
            text = "Connect"
            setOnClickListener {
                val url = normalizeRemoteUrl(urlInput.text.toString())
                if (url == null) {
                    showSetup("Remote link is not valid.")
                } else {
                    openRemote(url)
                }
            }
        }, LinearLayout.LayoutParams(0, dp(48), 1f).apply { leftMargin = dp(8) })
        setupPanel.addView(row, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(12) })
        root.addView(setupPanel, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))

        webView = WebView(this).apply {
            visibility = View.GONE
        }
        root.addView(webView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f,
        ))
        setContentView(root)
    }

    private fun openRemote(url: String) {
        prefs.edit().putString(KEY_REMOTE_URL, url).apply()
        statusText.text = "Loading $url"
        progress.visibility = View.VISIBLE
        setupPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl(url)
    }

    private fun showSetup(message: String) {
        statusText.text = message
        progress.visibility = View.GONE
        webView.visibility = View.GONE
        setupPanel.visibility = View.VISIBLE
    }

    private fun pasteClipboard() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
        val url = normalizeRemoteUrl(text)
        if (url == null) {
            showSetup("Clipboard does not contain a Zira TV Remote link.")
        } else {
            urlInput.setText(url)
            openRemote(url)
        }
    }

    private fun remoteUrlFromIntent(intent: Intent?): String? {
        if (intent == null) return null
        intent.dataString?.let { return it }
        if (intent.action == Intent.ACTION_SEND) {
            return intent.getStringExtra(Intent.EXTRA_TEXT)
        }
        return null
    }

    private fun normalizeRemoteUrl(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isBlank()) return null
        val url = if (trimmed.matches(Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+.*"))) {
            "http://$trimmed"
        } else {
            trimmed
        }
        val uri = try { Uri.parse(url) } catch (_: Exception) { return null }
        if (uri.scheme != "http" && uri.scheme != "https") return null
        if (uri.host.isNullOrBlank()) return null
        return if (uri.path == "/remote") url else uri.buildUpon().path("/remote").build().toString()
    }

    private fun extractUris(data: Intent?): Array<Uri>? {
        if (data == null) return null
        val clip: ClipData? = data.clipData
        if (clip != null && clip.itemCount > 0) {
            return Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
        }
        return data.data?.let { arrayOf(it) }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val KEY_REMOTE_URL = "remoteUrl"
        private const val FILE_CHOOSER_REQUEST = 5107
    }
}
