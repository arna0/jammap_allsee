package app.jammap

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/** Rolling 2-minute chart: top-4 C/N0 (teal) and AGC change vs baseline (amber). */
class SignalChartView(context: Context) : View(context) {
    private val cn0 = ArrayDeque<Double>()
    private val dAgc = ArrayDeque<Double?>()
    private val maxPoints = 120

    private val cn0Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#2EE6C5"); strokeWidth = 5f; style = Paint.Style.STROKE }
    private val agcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#FFB547"); strokeWidth = 4f; style = Paint.Style.STROKE }
    private val gridPaint = Paint().apply { color = Color.parseColor("#1F2A3C"); strokeWidth = 2f }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#8091AB"); textSize = 28f }

    fun push(top4: Double, agcDelta: Double?) {
        cn0.addLast(top4)
        dAgc.addLast(agcDelta)
        while (cn0.size > maxPoints) cn0.removeFirst()
        while (dAgc.size > maxPoints) dAgc.removeFirst()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.parseColor("#0E131D"))
        val w = width.toFloat()
        val h = height.toFloat()
        for (i in 1..3) canvas.drawLine(0f, h * i / 4, w, h * i / 4, gridPaint)
        canvas.drawText("C/N0 dB-Hz (10–50)", 16f, 34f, textPaint.apply { color = cn0Paint.color })
        canvas.drawText("ΔAGC dB (±12)", w - 230f, 34f, textPaint.apply { color = agcPaint.color })

        fun x(i: Int) = w * i / (maxPoints - 1)
        val p = Path()
        cn0.forEachIndexed { i, v ->
            val y = h - ((v.coerceIn(10.0, 50.0) - 10) / 40 * h).toFloat()
            if (i == 0) p.moveTo(x(i), y) else p.lineTo(x(i), y)
        }
        canvas.drawPath(p, cn0Paint)

        val q = Path()
        var started = false
        dAgc.forEachIndexed { i, v ->
            if (v == null) { started = false; return@forEachIndexed }
            val y = h / 2 - (v.coerceIn(-12.0, 12.0) / 24 * h).toFloat()
            if (!started) { q.moveTo(x(i), y); started = true } else q.lineTo(x(i), y)
        }
        canvas.drawPath(q, agcPaint)
    }
}
