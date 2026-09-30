package com.parspec.events;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

// Minimal RFC 8259 JSON: objects -> LinkedHashMap, arrays -> ArrayList, integers -> Long (BigInteger
// beyond Long), decimals -> BigDecimal (so "12.3400" keeps its digits). Nesting is capped at MAX_DEPTH so
// a deep body is an error, not a StackOverflowError.
// ponytail: hand-rolled to keep the SDK dependency-free; swap for Jackson if it ever needs more than the envelope.
final class Json {
    static final int MAX_DEPTH = 512;
    private static final Pattern NUMBER = Pattern.compile("-?(0|[1-9]\\d*)(\\.\\d+)?([eE][+-]?\\d+)?");
    private static final Pattern INTEGER = Pattern.compile("-?(0|[1-9]\\d*)");
    private static final String HEX = "0123456789abcdef";
    private final String s;
    private int i;
    private int depth;

    private Json(String s) { this.s = s; }

    static Object parse(String text) {
        Json p = new Json(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != p.s.length()) throw p.err("trailing characters");
        return v;
    }

    private IllegalArgumentException err(String msg) { return new IllegalArgumentException("invalid JSON at " + i + ": " + msg); }

    private void ws() {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
            i++;
        }
    }

    private char peek() { if (i >= s.length()) throw err("unexpected end"); return s.charAt(i); }

    private void expect(String lit) {
        if (!s.startsWith(lit, i)) throw err("expected " + lit);
        i += lit.length();
    }

    private Object value() {
        char c = peek();
        switch (c) {
            case '{': case '[':
                if (++depth > MAX_DEPTH) throw err("nested deeper than " + MAX_DEPTH);
                Object nested = c == '{' ? object() : array();
                depth--;
                return nested;
            case '"': return string();
            case 't': expect("true"); return Boolean.TRUE;
            case 'f': expect("false"); return Boolean.FALSE;
            case 'n': expect("null"); return null;
            default: return number();
        }
    }

    private Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++; ws();
        if (peek() == '}') { i++; return m; }
        while (true) {
            ws();
            if (peek() != '"') throw err("expected key");
            String k = string();
            ws(); expect(":"); ws();
            m.put(k, value());
            ws();
            char c = peek(); i++;
            if (c == '}') return m;
            if (c != ',') throw err("expected , or }");
        }
    }

    private List<Object> array() {
        List<Object> a = new ArrayList<>();
        i++; ws();
        if (peek() == ']') { i++; return a; }
        while (true) {
            ws();
            a.add(value());
            ws();
            char c = peek(); i++;
            if (c == ']') return a;
            if (c != ',') throw err("expected , or ]");
        }
    }

    private String string() {
        StringBuilder b = new StringBuilder();
        i++;
        while (true) {
            char c = peek(); i++;
            if (c == '"') return b.toString();
            if (c < 0x20) throw err("control character in string");
            if (c != '\\') { b.append(c); continue; }
            char e = peek(); i++;
            switch (e) {
                case '"': case '\\': case '/': b.append(e); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'n': b.append('\n'); break;
                case 'r': b.append('\r'); break;
                case 't': b.append('\t'); break;
                case 'u':
                    if (i + 4 > s.length()) throw err("bad \\u escape");
                    int cp = 0;
                    for (int k = 0; k < 4; k++) {
                        int d = HEX.indexOf(Character.toLowerCase(s.charAt(i + k)));
                        if (d < 0) throw err("bad \\u escape");
                        cp = cp * 16 + d;
                    }
                    b.append((char) cp);
                    i += 4;
                    break;
                default: throw err("bad escape");
            }
        }
    }

    private Object number() {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        String n = s.substring(start, i);
        if (n.isEmpty()) throw err("unexpected character");
        if (!NUMBER.matcher(n).matches()) throw err("bad number " + (n.length() > 40 ? n.substring(0, 40) + "..." : n));
        if (!INTEGER.matcher(n).matches()) return new BigDecimal(n);
        BigInteger big = new BigInteger(n);
        return big.bitLength() < 64 ? (Object) big.longValue() : big;
    }

    static String write(Object v) {
        StringBuilder b = new StringBuilder();
        write(v, b);
        return b.toString();
    }

    private static void write(Object v, StringBuilder b) {
        if (v == null) b.append("null");
        else if (v instanceof String) quote((String) v, b);
        else if (v instanceof Double && !Double.isFinite((Double) v) || v instanceof Float && !Float.isFinite((Float) v))
            throw new IllegalArgumentException("cannot write " + v + " as JSON");
        else if (v instanceof Boolean || v instanceof Number) b.append(v);
        else if (v instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) b.append(',');
                first = false;
                quote(String.valueOf(e.getKey()), b);
                b.append(':');
                write(e.getValue(), b);
            }
            b.append('}');
        } else if (v instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object o : (List<?>) v) {
                if (!first) b.append(',');
                first = false;
                write(o, b);
            }
            b.append(']');
        } else throw new IllegalArgumentException("cannot write " + v.getClass());
    }

    private static void quote(String s, StringBuilder b) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        b.append('"');
    }
}
