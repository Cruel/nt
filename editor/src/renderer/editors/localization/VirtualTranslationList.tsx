import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, type ReactNode } from 'react';

interface VirtualTranslationListProps<T extends { id: string }> {
  messages: readonly T[];
  resetKey: string;
  expandedMessageId: string | null;
  renderMessage: (message: T) => ReactNode;
}

export function VirtualTranslationList<T extends { id: string }>({
  messages,
  resetKey,
  expandedMessageId,
  renderMessage,
}: VirtualTranslationListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const expandedIndex = messages.findIndex((message) => message.id === expandedMessageId);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => messages[index]!.id,
    estimateSize: () => 62,
    overscan: 6,
    // Keep the one active editor mounted when it scrolls outside the viewport.
    rangeExtractor: (range) => {
      const visible = defaultRangeExtractor(range);
      return expandedIndex >= 0 && !visible.includes(expandedIndex)
        ? [...visible, expandedIndex].sort((a, b) => a - b)
        : visible;
    },
    initialRect: { width: 900, height: 550 },
  });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]);

  return (
    <div
      ref={scrollRef}
      data-testid="translation-viewport"
      className="min-h-0 flex-1 overflow-auto overscroll-contain"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderMessage(messages[row.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}
