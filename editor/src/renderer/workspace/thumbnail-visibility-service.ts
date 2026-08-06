const THUMBNAIL_PREFETCH_MARGIN = '240px 0px';

type VisibilityCallback = (visible: boolean) => void;

let observer: IntersectionObserver | null = null;
const callbacks = new Map<Element, VisibilityCallback>();

function sharedObserver() {
  if (observer || typeof IntersectionObserver === 'undefined') return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: THUMBNAIL_PREFETCH_MARGIN },
  );
  return observer;
}

export function observeThumbnailVisibility(element: Element, callback: VisibilityCallback) {
  const currentObserver = sharedObserver();
  if (!currentObserver) {
    callback(true);
    return () => undefined;
  }
  callbacks.set(element, callback);
  currentObserver.observe(element);
  return () => {
    callbacks.delete(element);
    currentObserver.unobserve(element);
  };
}
