package app.jammap

import android.content.Context
import android.util.Base64
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom

/**
 * The phone's ed25519 identity. It signs reports; it never holds SOL and never signs transactions.
 * MVP stores the seed in app-private SharedPreferences. Production: Android Keystore / StrongBox
 * plus Play Integrity attestation so one person can't cheaply spin up many "phones".
 */
class DeviceKey private constructor(private val priv: Ed25519PrivateKeyParameters) {
    val publicKey: ByteArray = priv.generatePublicKey().encoded
    val address: String = Base58.encode(publicKey)

    fun sign(message: ByteArray): ByteArray {
        val s = Ed25519Signer()
        s.init(true, priv)
        s.update(message, 0, message.size)
        return s.generateSignature()
    }

    fun signB64(message: ByteArray): String = Base64.encodeToString(sign(message), Base64.NO_WRAP)

    companion object {
        private const val PREF = "jammap"
        private const val KEY = "device_seed"

        fun load(ctx: Context): DeviceKey {
            val prefs = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            val stored = prefs.getString(KEY, null)
            val seed = if (stored != null) {
                Base64.decode(stored, Base64.NO_WRAP)
            } else {
                ByteArray(32).also {
                    SecureRandom().nextBytes(it)
                    prefs.edit().putString(KEY, Base64.encodeToString(it, Base64.NO_WRAP)).apply()
                }
            }
            return DeviceKey(Ed25519PrivateKeyParameters(seed, 0))
        }
    }
}
