package app.jammap

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Tiny JSON-over-HTTP client for the relayer. Calls run off the main thread. */
class Api(@Volatile var baseUrl: String) {
    data class Response(val status: Int, val body: JSONObject)

    private val io = Executors.newSingleThreadExecutor()

    fun post(path: String, body: JSONObject, done: (Response) -> Unit) {
        io.execute {
            val res = try {
                val conn = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 5000
                conn.readTimeout = 30000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = conn.responseCode
                val stream = if (code >= 400) conn.errorStream else conn.inputStream
                val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                Response(code, runCatching { JSONObject(text) }.getOrElse { JSONObject().put("raw", text) })
            } catch (e: Exception) {
                Response(0, JSONObject().put("error", e.message ?: e.javaClass.simpleName))
            }
            done(res)
        }
    }
}
