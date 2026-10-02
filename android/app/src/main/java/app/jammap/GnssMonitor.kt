package app.jammap

import android.annotation.SuppressLint
import android.content.Context
import android.location.GnssMeasurementsEvent
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Streams raw GNSS measurements (one epoch per second) as [Detector.Epoch]s:
 * strongest L1/E1/B1/G1 C/N0 per satellite + median receiver AGC for that band.
 * Requires the GPS provider to be running, so we also request location updates.
 */
class GnssMonitor(context: Context, private val onEpoch: (Detector.Epoch) -> Unit) {
    private val lm = context.getSystemService(LocationManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var lastLoc: Location? = null

    private val locationListener = LocationListener { lastLoc = it }

    private val callback = object : GnssMeasurementsEvent.Callback() {
        override fun onGnssMeasurementsReceived(event: GnssMeasurementsEvent) {
            val perSat = HashMap<String, Double>()
            val agcs = ArrayList<Double>()
            for (m in event.measurements) {
                val freq = if (m.hasCarrierFrequencyHz()) m.carrierFrequencyHz.toDouble() else L1_HZ
                if (freq < UPPER_L_BAND_MIN_HZ) continue // skip L5/E5a; keep the upper L-band only
                val key = "${m.constellationType}:${m.svid}"
                perSat[key] = maxOf(perSat[key] ?: 0.0, m.cn0DbHz)
                if (Build.VERSION.SDK_INT < 34) legacyAgc(m)?.let { agcs += it }
            }
            if (Build.VERSION.SDK_INT >= 34) {
                for (a in event.gnssAutomaticGainControls) {
                    if (a.carrierFrequencyHz >= UPPER_L_BAND_MIN_HZ) agcs += a.levelDb
                }
            }
            val agc = if (agcs.isEmpty()) null else agcs.sorted()[agcs.size / 2]
            val loc = lastLoc
            onEpoch(Detector.Epoch(System.currentTimeMillis(), perSat.values.toList(), agc, loc?.latitude, loc?.longitude))
        }

        override fun onStatusChanged(status: Int) {
            if (status != STATUS_READY) onStatus?.invoke(
                when (status) {
                    STATUS_NOT_SUPPORTED -> "This phone does not expose raw GNSS measurements"
                    STATUS_LOCATION_DISABLED -> "Turn on Location (GPS)"
                    else -> "GNSS measurements status $status"
                }
            )
        }
    }

    var onStatus: ((String) -> Unit)? = null
    val location: Location? get() = lastLoc

    @SuppressLint("MissingPermission")
    fun start() {
        lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, locationListener, Looper.getMainLooper())
        lm.registerGnssMeasurementsCallback(callback, main)
    }

    fun stop() {
        lm.unregisterGnssMeasurementsCallback(callback)
        lm.removeUpdates(locationListener)
    }

    @Suppress("DEPRECATION")
    private fun legacyAgc(m: android.location.GnssMeasurement): Double? =
        if (m.hasAutomaticGainControlLevelDb()) m.automaticGainControlLevelDb else null

    companion object {
        private const val L1_HZ = 1_575_420_000.0
        private const val UPPER_L_BAND_MIN_HZ = 1_500_000_000L
    }
}
