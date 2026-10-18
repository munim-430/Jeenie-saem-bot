// Object URLs for spoken audio. Revoking a URL that an <audio> element is still loading makes the
// browser log "net::ERR_FILE_NOT_FOUND" (e.g. when autoplay is refused on page load and playback is
// abandoned at once), so the element lets go of the URL first.

type AudioLike = Pick<HTMLMediaElement, "getAttribute" | "removeAttribute" | "load">;

export function releaseAudioUrl(element: AudioLike, url: string, revoke: (url: string) => void = URL.revokeObjectURL): void {
  if (element.getAttribute("src") === url) {
    element.removeAttribute("src");
    // Aborts the pending load of the removed source, so nothing reads the URL after it is revoked.
    element.load();
  }
  revoke(url);
}
