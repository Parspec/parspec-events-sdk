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

    // The signature did not verify: the request did not come from PM, or the key is stale.
    public static class SignatureException extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public SignatureException(String message) { super(message); }
    }

    // The signature verified, but the body is not a PM event envelope.
    public static class EventException extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;
        public EventException(String message, Throwable cause) { super(message, cause); }
    }

    // event is the parsed JSON (Map/List/String/Long/Double/Boolean). To bind it to your own types
    // (e.g. Jackson in Spring Boot), parse the same raw bytes again after verifying.
    public record ParsedEvent(Map<String, Object> event, String transactionId, String callbackUrl, String idempotencyKey) {}

    // True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes, false otherwise.
    // Never throws: a bad signature, a bad key and a non-RSA key all return false.
    // Re-serialized JSON will not verify. In Spring Boot, take the body as @RequestBody byte[].
    public static boolean verify(byte[] rawBody, String signature, String publicKeyPem) {
        if (rawBody == null || signature == null || signature.isEmpty() || publicKeyPem == null) return false;
        try {
            java.security.Signature v = java.security.Signature.getInstance("SHA256withRSA");
            v.initVerify(publicKey(publicKeyPem));
            v.update(rawBody);
            return v.verify(Base64.getDecoder().decode(signature));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return false;
        }
    }

    // Verify then parse. Throws SignatureException on a bad or missing signature, EventException when a
    // signed body is not a PM event. Deduplicate on transactionId: PM can deliver an event twice.
    @SuppressWarnings("unchecked")
    public static ParsedEvent parseEvent(byte[] rawBody, String signature, String publicKeyPem, String idempotencyKey) {
        if (!verify(rawBody, signature, publicKeyPem)) throw new SignatureException("X-Signature did not verify");
        Object parsed;
        try {
            parsed = Json.parse(new String(rawBody, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            throw new EventException("body is not JSON: " + e.getMessage(), e);
        }
        String txid = parsed instanceof Map ? str(((Map<?, ?>) parsed).get("eventTransactionID")) : null;
        if (txid == null || txid.isEmpty()) throw new EventException("body is not a PM event: expected an object with an eventTransactionID", null);
        Map<String, Object> event = (Map<String, Object>) parsed;
        return new ParsedEvent(event, txid, str(event.get("callback_url")), idempotencyKey);
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
