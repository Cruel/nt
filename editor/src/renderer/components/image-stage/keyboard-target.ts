export function isTextEntryKeyboardTarget(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return (
    element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null
  );
}
