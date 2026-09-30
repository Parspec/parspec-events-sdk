package com.parspec.events;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

// Lives in the SDK package so it can reuse the package-private Json.
@SuppressWarnings("unchecked")
public final class Cli {
    public static void main(String[] a) throws Exception {
        Map<String, Object> q = (Map<String, Object>) Json.parse(new String(System.in.readAllBytes(), "UTF-8"));
        try {
            ParspecClient client = "verify".equals(q.get("op")) ? null : new ParspecClient((String) q.get("apiKey"), (String) q.get("base"), null);
            Object out;
            switch ((String) q.get("op")) {
                case "verify": {
                    List<Object> r = new ArrayList<>();
                    for (Object o : (List<Object>) q.get("cases")) {
                        Map<String, Object> c = (Map<String, Object>) o;
                        r.add(Signature.verify(Base64.getDecoder().decode((String) c.get("body")), (String) c.get("signature"), (String) c.get("publicKey")));
                    }
                    out = r; break;
                }
                case "callback": {
                    List<Object> r = new ArrayList<>();
                    for (Object o : (List<Object>) q.get("cases")) {
                        Map<String, Object> c = (Map<String, Object>) o;
                        Signature.ParsedEvent evt = Signature.parseEvent(Base64.getDecoder().decode((String) c.get("body")), (String) c.get("signature"), (String) q.get("publicKey"));
                        client.callback(evt, (Map<String, Object>) c.get("fields"));
                        r.add(evt.transactionId());
                    }
                    out = r; break;
                }
                case "subscribe": {
                    ParspecClient.SubscribeResult r = client.subscribe((String) q.get("eventType"), ((Long) q.get("version")).intValue(), (String) q.get("webhookUrl"));
                    out = Map.of("publicKey", r.publicKey(), "replaced", (long) r.replaced()); break;
                }
                case "unsubscribe": {
                    List<Object> r = new ArrayList<>();
                    Object v = q.get("version");
                    for (ParspecClient.Response x : client.unsubscribe((String) q.get("eventType"), v == null ? null : ((Long) v).intValue())) r.add((long) x.status());
                    out = r; break;
                }
                default: throw new IllegalArgumentException("unknown op");
            }
            System.out.print(Json.write(out));
        } catch (ParspecClient.ParspecApiException e) {
            System.out.print(Json.write(Map.of("error", e.getMessage(), "status", (long) e.status())));
            System.exit(1);
        } catch (Exception e) {
            System.out.print(Json.write(Map.of("error", String.valueOf(e.getMessage()))));
            System.exit(1);
        }
    }

}
