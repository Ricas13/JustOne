import zlib from "node:zlib";

export function acceptsGzip(value) {
  const header = String(value || "").toLowerCase();
  if (!header) return false;
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    if (name.trim() !== "gzip" && name.trim() !== "*") return false;
    const q = params
      .map((x) => x.trim())
      .find((x) => x.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

export function encodeXmlPayload(xml, acceptEncoding = "") {
  const plain = Buffer.from(String(xml || ""), "utf8");
  if (!acceptsGzip(acceptEncoding)) {
    return { body: plain, encoding: "", originalBytes: plain.length, bytes: plain.length };
  }
  const body = zlib.gzipSync(plain, { level: 6 });
  return { body, encoding: "gzip", originalBytes: plain.length, bytes: body.length };
}
