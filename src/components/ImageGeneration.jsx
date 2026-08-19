import styles from "./ImageGeneration.module.css";

function normalizedStatus(status) {
  return String(status ?? "inProgress").toLowerCase();
}

function fileUrl(path) {
  if (!path || !String(path).startsWith("/")) return "";
  return encodeURI(`file://${path}`);
}

export function imageGenerationSource(result, savedPath) {
  const value = typeof result === "string" ? result.trim() : "";
  if (value) {
    if (/^(?:data:image\/|https?:\/\/|blob:|file:\/\/)/i.test(value)) return value;
    if (value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        const nested = parsed.image_url ?? parsed.imageUrl ?? parsed.url ?? parsed.output ?? parsed.result;
        const source = imageGenerationSource(nested, savedPath);
        if (source) return source;
      } catch {
        // The protocol normally returns a data URL or base64 string. A malformed
        // JSON-looking result should fall through to the saved file, if present.
      }
    }
    if (/^[a-z\d+/=\s]+$/i.test(value) && value.replace(/\s/g, "").length > 128) {
      return `data:image/png;base64,${value.replace(/\s/g, "")}`;
    }
    const resultFile = fileUrl(value);
    if (resultFile) return resultFile;
  }
  return fileUrl(savedPath);
}

function failureMessage(failure) {
  if (failure?.type === "usageLimitExceeded") return "Image generation limit reached";
  return "Image generation failed";
}

export function ImageGeneration({
  prompt,
  resolution = "1024 × 1024",
  result = "",
  savedPath = null,
  revisedPrompt = null,
  status = "inProgress",
  failure = null
}) {
  const source = imageGenerationSource(result, savedPath);
  const state = normalizedStatus(status);
  const failed = Boolean(failure) || state === "failed" || state === "error";
  const complete = Boolean(source) || state === "completed" || state === "complete";
  const displayPrompt = revisedPrompt || prompt;
  const label = failed ? failureMessage(failure) : complete ? "Generated image" : "Generating image";

  return (
    <figure className={styles.igWrap} data-state={failed ? "failed" : complete ? "complete" : "generating"}>
      {source ? (
        <a className={styles.igResultLink} href={source} target="_blank" rel="noreferrer" aria-label="Open generated image">
          <img className={styles.igResult} src={source} alt={displayPrompt || "Generated image"} />
        </a>
      ) : (
        <div className={styles.igCanvas} role="img" aria-label={label}>
          <span className={styles.igDots} aria-hidden="true" />
          <span className={styles.igGlow} aria-hidden="true" />
          <span className={styles.igRes}>{resolution}</span>
        </div>
      )}
      <figcaption className={styles.igMeta}>
        <span className={styles.igLabel}>{label}</span>
        {displayPrompt && <span className={styles.igPrompt}>“{displayPrompt}”</span>}
      </figcaption>
    </figure>
  );
}
