package com.aegis.browser

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
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

  private fun logKeySecurityLevel(key: SecretKey) {
    try {
      val factory = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore")
      val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
      val level = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        when (info.securityLevel) {
          KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
          KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE"
          KeyProperties.SECURITY_LEVEL_SOFTWARE -> "SOFTWARE"
          else -> "UNKNOWN(${info.securityLevel})"
        }
      } else {
        @Suppress("DEPRECATION")
        if (info.isInsideSecureHardware) "SECURE_HW(pre-S)" else "SOFTWARE(pre-S)"
      }
      Log.i("AegisKeystore", "sync-seed key security level = $level")
    } catch (t: Throwable) {
      Log.w("AegisKeystore", "could not query key security level", t)
    }
  }

  private fun secretKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
      logKeySecurityLevel(it.secretKey)
      return it.secretKey
    }
    // No key yet — generate a non-exportable AES-256-GCM key bound to secure hardware.
    // Prefer a StrongBox Secure Element where the device has one; gracefully fall back to
    // the TEE/software-backed key (today's behavior) when StrongBox is unavailable, so this
    // never regresses on the common no-Secure-Element device (emulators, most phones).
    fun spec(strongBox: Boolean) =
      KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .apply { if (strongBox) setIsStrongBoxBacked(true) }
        .build()

    val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      try {
        kg.init(spec(true))
        val key = kg.generateKey()
        logKeySecurityLevel(key)
        return key
      } catch (_: android.security.keystore.StrongBoxUnavailableException) {
        // No Secure Element — re-init the SAME generator without StrongBox.
      }
    }
    kg.init(spec(false))
    val key = kg.generateKey()
    logKeySecurityLevel(key)
    return key
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
