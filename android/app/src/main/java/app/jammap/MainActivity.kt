package app.jammap

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * One-screen app: live signal state, a 2-minute chart, and controls.
 * Built in code (no XML/AndroidX) so the project stays tiny and easy to read.
 */
class MainActivity : Activity() {
    private lateinit var key: DeviceKey
    private lateinit var api: Api
    private lateinit var monitor: GnssMonitor
    private val detector = Detector()

    private lateinit var stateView: TextView
    private lateinit var metricsView: TextView
    private lateinit var chart: SignalChartView
    private lateinit var logView: TextView
    private lateinit var serverInput: EditText
    private lateinit var ownerInput: EditText
    private lateinit var startBtn: Button
    private lateinit var testChk: CheckBox

    private var running = false
    private var lastHeartbeat = 0L
    private var reportsSent = 0
    private val log = ArrayDeque<String>()
    private val prefs by lazy { getSharedPreferences("jammap", Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        key = DeviceKey.load(this)
        api = Api(prefs.getString("server", "http://192.168.1.10:8787")!!)
        monitor = GnssMonitor(this) { e -> runOnUiThread { onEpoch(e) } }
        monitor.onStatus = { msg -> runOnUiThread { addLog(msg) } }
        setContentView(buildUi())
        addLog("Device key ${key.address.take(6)}…${key.address.takeLast(6)}")
        if (!prefs.getBoolean("registered", false)) addLog("Enter a reward wallet and tap Register")
    }

    // ---------------------------------------------------------------- detection loop

    private fun onEpoch(raw: Detector.Epoch) {
        // TEST mode injects a synthetic jammer signature into real measurements so the
        // full pipeline can be shown without transmitting anything (jamming is illegal).
        val e = if (testChk.isChecked) raw.copy(cn0 = raw.cn0.map { (it - 18).coerceAtLeast(0.0) }, agc = raw.agc?.minus(6)) else raw
        val r = detector.update(e)
        val f = r.features
        chart.push(f.top4, f.dAgc)
        renderState(r.state)
        val cell = if (e.lat != null && e.lon != null) Protocol.cellId(e.lat, e.lon) else null
        metricsView.text = buildString {
            append("satellites  ${f.nSats}\n")
            append("C/N0 top-4  %.1f dB-Hz   Δ %+.1f\n".format(f.top4, f.dCn0))
            append("AGC         ${f.agc?.let { "%.1f dB   Δ %+.1f".format(it, f.dAgc ?: 0.0) } ?: "not exposed by this phone"}\n")
            append("position    ${if (e.lat != null) "%.5f, %.5f".format(e.lat, e.lon) else "waiting for fix…"}\n")
            append("zone        ${cell ?: "—"}\n")
            append("reports     $reportsSent sent")
        }

        val now = System.currentTimeMillis()
        if (prefs.getBoolean("registered", false) && e.lat != null && now - lastHeartbeat > 10_000) {
            lastHeartbeat = now
            heartbeat(e.lat, e.lon!!)
        }
        val rep = r.report ?: return
        if (e.lat == null || e.lon == null) {
            addLog("Detected ${r.state}, but there is no position fix yet. Not reported.")
            return
        }
        sendReport(e.lat, e.lon, rep, f)
    }

    private fun renderState(state: String) {
        val (label, color) = when (state) {
            "warmup" -> "Calibrating…" to "#3A4250"
            "clean" -> "No interference" to "#1B6E45"
            "jamming" -> "Jamming detected" to "#B42F35"
            "spoofing" -> "Spoofing detected" to "#6E35AD"
            "obstruction" -> "Signal blocked, not reported" to "#7A5A1E"
            else -> "Weak signal" to "#4A5260"
        }
        stateView.text = label
        stateView.setBackgroundColor(Color.parseColor(color))
    }

    // ---------------------------------------------------------------- relayer calls

    private fun register() {
        val owner = ownerInput.text.toString().trim()
        val ownerBytes = runCatching { Base58.decode(owner) }.getOrNull()
        if (ownerBytes == null || ownerBytes.size != 32) {
            addLog("Error: reward wallet must be a Solana address")
            return
        }
        saveInputs()
        val body = JSONObject()
            .put("deviceKey", key.address)
            .put("owner", owner)
            .put("signature", key.signB64(Protocol.registerMessage(ownerBytes)))
            .put("label", android.os.Build.MODEL)
        addLog("Registering…")
        api.post("/v1/devices/register", body) { res ->
            runOnUiThread {
                if (res.status == 200) {
                    prefs.edit().putBoolean("registered", true).apply()
                    addLog("Registered" + (res.body.optString("tx").takeIf { it.isNotEmpty() && it != "null" }?.let { " tx ${it.take(8)}…" } ?: ""))
                } else addLog("Error: register ${res.status}: ${res.body.optString("error")}")
            }
        }
    }

    private fun sendReport(lat: Double, lon: Double, rep: Detector.Report, f: Detector.Features) {
        val ts = System.currentTimeMillis() / 1000
        val cell = Protocol.cellId(lat, lon)
        val features = JSONObject()
            .put("nSats", f.nSats)
            .put("dCn0", "%.2f".format(Locale.US, f.dCn0).toDouble())
            .put("dAgc", f.dAgc?.let { "%.2f".format(Locale.US, it).toDouble() } ?: JSONObject.NULL)
            .put("spread", f.spread?.let { "%.2f".format(Locale.US, it).toDouble() } ?: JSONObject.NULL)
            .put("teleport", f.teleport)
        val body = JSONObject()
            .put("deviceKey", key.address)
            .put("lat", lat)
            .put("lon", lon)
            .put("cellId", cell.toString())
            .put("ts", ts)
            .put("kind", rep.kind)
            .put("severity", rep.severity)
            .put("features", features)
            .put("signature", key.signB64(Protocol.reportMessage(cell, ts, rep.kind, rep.severity)))
            .put("test", testChk.isChecked)
        val what = if (rep.kind == Protocol.KIND_JAMMING) "jamming" else "spoofing"
        addLog("Sent signed $what report (sev ${rep.severity}) for zone $cell")
        api.post("/v1/reports", body) { res ->
            runOnUiThread {
                if (res.status == 202) {
                    reportsSent++
                    val inc = res.body.optJSONObject("incident")
                    val n = inc?.optInt("reporters") ?: 0
                    val q = inc?.optInt("quorum") ?: 3
                    addLog("Accepted · $n of $q phones in this zone" + if (inc?.optBoolean("confirmed") == true) " · confirmed" else "")
                } else addLog("Error: report ${res.status}: ${res.body.optString("error")}")
            }
        }
    }

    private fun heartbeat(lat: Double, lon: Double) {
        val ts = System.currentTimeMillis() / 1000
        val body = JSONObject()
            .put("deviceKey", key.address)
            .put("ts", ts)
            .put("lat", lat)
            .put("lon", lon)
            .put("signature", key.signB64(Protocol.heartbeatMessage(ts)))
        api.post("/v1/heartbeat", body) { }
    }

    // ---------------------------------------------------------------- lifecycle & permissions

    private fun toggle() {
        if (running) {
            monitor.stop()
            running = false
            startBtn.text = "Start listening"
            addLog("Stopped")
            return
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), 1)
            return
        }
        saveInputs()
        monitor.start()
        running = true
        startBtn.text = "Stop"
        addLog("Listening to satellites…")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) toggle() else addLog("Error: location permission is required")
    }

    override fun onDestroy() {
        if (running) monitor.stop()
        super.onDestroy()
    }

    private fun saveInputs() {
        api.baseUrl = serverInput.text.toString().trim()
        prefs.edit()
            .putString("server", api.baseUrl)
            .putString("owner", ownerInput.text.toString().trim())
            .apply()
    }

    private fun addLog(line: String) {
        val t = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        log.addFirst("$t  $line")
        while (log.size > 14) log.removeLast()
        if (::logView.isInitialized) logView.text = log.joinToString("\n")
    }

    // ---------------------------------------------------------------- UI

    private fun buildUi(): View {
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val mono = Typeface.MONOSPACE

        fun label(text: String, size: Float = 13f, color: String = "#8091AB") = TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(Color.parseColor(color))
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.parseColor("#070A10"))
        }
        root.addView(label("JamMap", 24f, "#E6EDF7").apply { typeface = Typeface.DEFAULT_BOLD })
        root.addView(label("Your phone listens for GPS jamming and spoofing. It never transmits."))

        stateView = TextView(this).apply {
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, pad, 0, pad)
            text = "Not listening"
            setBackgroundColor(Color.parseColor("#3A4250"))
        }
        root.addView(stateView, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = pad })

        chart = SignalChartView(this)
        root.addView(chart, LinearLayout.LayoutParams(MATCH_PARENT, (170 * dp).toInt()).apply { topMargin = pad / 2 })

        metricsView = label("", 13f, "#E6EDF7").apply { typeface = mono; setPadding(0, pad / 2, 0, pad / 2) }
        root.addView(metricsView)

        serverInput = EditText(this).apply {
            setText(api.baseUrl)
            hint = "relayer URL, e.g. http://192.168.1.10:8787"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#55627A"))
        }
        ownerInput = EditText(this).apply {
            setText(prefs.getString("owner", ""))
            hint = "reward wallet (Solana address)"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#55627A"))
        }
        root.addView(label("Relayer"))
        root.addView(serverInput)
        root.addView(label("Reward wallet"))
        root.addView(ownerInput)

        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        startBtn = Button(this).apply { text = "Start listening"; setOnClickListener { toggle() } }
        val regBtn = Button(this).apply { text = "Register"; setOnClickListener { register() } }
        buttons.addView(startBtn, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        buttons.addView(regBtn, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        root.addView(buttons)

        testChk = CheckBox(this).apply {
            text = "Test mode: add a simulated jamming signature"
            setTextColor(Color.parseColor("#FFB547"))
        }
        root.addView(testChk)

        logView = label("", 12f, "#9FB0C8").apply { typeface = mono; setPadding(0, pad / 2, 0, 0) }
        root.addView(logView)

        return ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#070A10"))
            addView(root)
        }
    }
}
