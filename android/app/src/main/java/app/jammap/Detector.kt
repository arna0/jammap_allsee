package app.jammap

import kotlin.math.max
import kotlin.math.sqrt

/**
 * GNSS interference detector. Port of server/src/detector.js — keep thresholds in sync,
 * the relayer re-runs [classify] on the features we send and rejects reports that disagree.
 *
 *   jamming      C/N0 down, AGC down  (noise floor rises, receiver turns gain down)
 *   spoofing     C/N0 up and uniform across satellites, AGC down (one loud fake transmitter)
 *   obstruction  C/N0 down, AGC UP    (pocket, tunnel, metal box) -> never reported
 * Without AGC we can't tell jamming from obstruction, so we refuse to report ("degraded").
 */
class Detector {
    data class Epoch(val tMs: Long, val cn0: List<Double>, val agc: Double?, val lat: Double?, val lon: Double?)
    data class Features(val nSats: Int, val top4: Double, val spread: Double?, val agc: Double?, val dCn0: Double, val dAgc: Double?, val teleport: Boolean)
    data class Report(val kind: Int, val severity: Int)
    data class Result(val state: String, val features: Features, val report: Report?)

    companion object {
        const val WARMUP = 20
        const val PERSIST = 5
        const val COOLDOWN_MS = 60_000L
        const val ALPHA = 0.05
        const val JAM_CN0_DROP = -8.0
        const val JAM_AGC_DROP = -2.0
        const val SPOOF_CN0_RISE = 5.0
        const val SPOOF_MAX_SPREAD = 2.5
        const val SPOOF_AGC_DROP = -2.0
        const val OBSTRUCTION_AGC_RISE = 1.0
        const val TELEPORT_KM = 2.0
        const val TELEPORT_MAX_SEC = 5.0

        /** Returns state to severity (0 when not reportable). */
        fun classify(f: Features): Pair<String, Int> {
            if (f.teleport) return "spoofing" to 3
            val dAgc = f.dAgc ?: return if (f.dCn0 <= JAM_CN0_DROP) "degraded" to 0 else "clean" to 0
            if (f.dCn0 <= JAM_CN0_DROP || f.nSats < 4) {
                if (dAgc <= JAM_AGC_DROP) {
                    val sev = when {
                        f.dCn0 <= -20 || f.nSats < 4 -> 3
                        f.dCn0 <= -14 -> 2
                        else -> 1
                    }
                    return "jamming" to sev
                }
                if (dAgc >= OBSTRUCTION_AGC_RISE) return "obstruction" to 0
                return "degraded" to 0
            }
            if (f.dCn0 >= SPOOF_CN0_RISE && f.spread != null && f.spread <= SPOOF_MAX_SPREAD && dAgc <= SPOOF_AGC_DROP) {
                return "spoofing" to (if (f.dCn0 >= 10) 2 else 1)
            }
            return "clean" to 0
        }

        fun haversineKm(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
            val r = 6371.0
            val dLat = Math.toRadians(bLat - aLat)
            val dLon = Math.toRadians(bLon - aLon)
            val h = Math.sin(dLat / 2).let { it * it } +
                Math.cos(Math.toRadians(aLat)) * Math.cos(Math.toRadians(bLat)) * Math.sin(dLon / 2).let { it * it }
            return 2 * r * Math.asin(sqrt(h))
        }
    }

    private var baseCn0: Double? = null
    private var baseAgc: Double? = null
    private var n = 0
    private var streakState: String? = null
    private var streakCount = 0
    private var streakMaxSev = 0
    private var lastReportAt = Long.MIN_VALUE / 2
    private var prevFix: Triple<Double, Double, Long>? = null

    val baselineCn0: Double? get() = baseCn0
    val baselineAgc: Double? get() = baseAgc

    fun update(e: Epoch): Result {
        val cn0 = e.cn0.filter { it > 0 }.sortedDescending()
        val top4 = if (cn0.isEmpty()) 0.0 else cn0.take(4).average()
        val spread = if (cn0.size >= 4) std(cn0.take(8)) else null

        var teleport = false
        if (e.lat != null && e.lon != null) {
            prevFix?.let { (pLat, pLon, pT) ->
                val dt = (e.tMs - pT) / 1000.0
                if (dt > 0 && dt <= TELEPORT_MAX_SEC && haversineKm(pLat, pLon, e.lat, e.lon) >= TELEPORT_KM) teleport = true
            }
            prevFix = Triple(e.lat, e.lon, e.tMs)
        }

        val f = Features(
            nSats = cn0.size,
            top4 = top4,
            spread = spread,
            agc = e.agc,
            dCn0 = baseCn0?.let { top4 - it } ?: 0.0,
            dAgc = if (e.agc != null && baseAgc != null) e.agc - baseAgc!! else null,
            teleport = teleport,
        )
        n++
        if (n <= WARMUP) {
            learn(f)
            return Result("warmup", f, null)
        }

        val (state, sev) = classify(f)
        if (state == "clean") learn(f)

        val reportable = state == "jamming" || state == "spoofing"
        if (reportable && streakState == state) {
            streakCount++
            streakMaxSev = max(streakMaxSev, sev)
        } else {
            streakState = if (reportable) state else null
            streakCount = if (reportable) 1 else 0
            streakMaxSev = sev
        }

        var report: Report? = null
        if (reportable && streakCount >= PERSIST && e.tMs - lastReportAt >= COOLDOWN_MS) {
            lastReportAt = e.tMs
            report = Report(if (state == "jamming") Protocol.KIND_JAMMING else Protocol.KIND_SPOOFING, streakMaxSev)
        }
        return Result(state, f, report)
    }

    private fun learn(f: Features) {
        if (f.nSats >= 4) baseCn0 = baseCn0?.let { it + ALPHA * (f.top4 - it) } ?: f.top4
        f.agc?.let { a -> baseAgc = baseAgc?.let { it + ALPHA * (a - it) } ?: a }
    }

    private fun std(xs: List<Double>): Double {
        val m = xs.average()
        return sqrt(xs.sumOf { (it - m) * (it - m) } / xs.size)
    }

}
