package com.parspec.events;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Map;

public final class Signature {
    private Signature() {}

    public static class SignatureException extends RuntimeException {
        public SignatureException(String message) { super(message); }
    }

    // event is the parsed JSON (Map/List/String/Long/Double/Boolean). To bind it to your own types
    // (e.g. Jackson in Spring Boot), parse the same raw bytes again after verifying.
    public record ParsedEvent(Map<String, Object> event, String transactionId, String callbackUrl, String idempotencyKey) {}

    // True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes.
    // Re-serialized JSON will not verify. In Spring Boot, take the body as @RequestBody byte[].
    public static boolean verify(byte[] rawBody, String signature, String publicKeyPem) {
        if (signature == null || signature.isEmpty()) return false;
        try {
            java.security.Signature v = java.security.Signature.getInstance("SHA256withRSA");
            v.initVerify(publicKey(publicKeyPem));
            v.update(rawBody);
            return v.verify(Base64.getDecoder().decode(signature));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return false;
        }
    }

    // Verify then parse. Throws SignatureException on a bad or missing signature.
    // Deduplicate on transactionId: PM can deliver the same event more than once.
    @SuppressWarnings("unchecked")
    public static ParsedEvent parseEvent(byte[] rawBody, String signature, String publicKeyPem, String idempotencyKey) {
        if (!verify(rawBody, signature, publicKeyPem)) throw new SignatureException("X-Signature did not verify");
        Map<String, Object> event = (Map<String, Object>) Json.parse(new String(rawBody, StandardCharsets.UTF_8));
        return new ParsedEvent(event, str(event.get("eventTransactionID")), str(event.get("callback_url")), idempotencyKey);
    }

    public static ParsedEvent parseEvent(byte[] rawBody, String signature, String publicKeyPem) {
        return parseEvent(rawBody, signature, publicKeyPem, null);
    }

    private static String str(Object o) { return o instanceof String ? (String) o : null; }

    private static PublicKey publicKey(String pem) throws GeneralSecurityException {
        String b64 = pem.replaceAll("-----(BEGIN|END) PUBLIC KEY-----", "").replaceAll("\\s", "");
        return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(b64)));
    }
}
