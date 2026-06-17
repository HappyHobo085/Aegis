package com.aegis.browser

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Wraps the 32-byte E2E-sync root with a non-exportable AES-256-GCM key held in the hardware
 * AndroidKeyStore (the Android equivalent of the desktop OS keychain). Called FROM Rust
 * (src/sync_keystore.rs) via a JNI up-call; static so the call needs no instance. Both
 * methods return null on any failure, so Rust falls back to the passphrase-wrapped vault.
 *
 * The blob is base64(iv ‖ ciphertext+tag). The key itself never leaves secure hardware.
 */
object AegisKeystore {
  private const val ALIAS = "aegis-sync-root-key"
  private const val TRANSFORM = "AES/GCM/NoPadding"
  private const val IV_LEN = 12
  private const val TAG_BITS = 128

  private fun secretKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    kg.init(
      KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return kg.generateKey()
  }

  @JvmStatic
  fun wrap(data: ByteArray): String? =
    try {
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.ENCRYPT_MODE, secretKey())
      val iv = cipher.iv
      val ct = cipher.doFinal(data)
      val out = ByteArray(iv.size + ct.size)
      System.arraycopy(iv, 0, out, 0, iv.size)
      System.arraycopy(ct, 0, out, iv.size, ct.size)
      Base64.encodeToString(out, Base64.NO_WRAP)
    } catch (t: Throwable) {
      null
    }

  @JvmStatic
  fun unwrap(blob: String): ByteArray? =
    try {
      val raw = Base64.decode(blob, Base64.NO_WRAP)
      if (raw.size <= IV_LEN) {
        null
      } else {
        val iv = raw.copyOfRange(0, IV_LEN)
        val ct = raw.copyOfRange(IV_LEN, raw.size)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
        cipher.doFinal(ct)
      }
    } catch (t: Throwable) {
      null
    }
}
