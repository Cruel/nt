import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  animate as animateMotion,
  motion,
  useAnimate,
  useMotionValue,
  useReducedMotion,
} from 'motion/react';
import type { StageRect } from '@/components/image-stage/image-stage-transforms';
import {
  screenPresentationToLocal,
  type FocusTransitionImagePresentation,
} from './focus-transition-presentation';

const COVER_SECONDS = 0.1;
const IMAGE_MOVE_SECONDS = 0.14;
const EDITOR_FADE_SECONDS = 0.12;
const EASING = 'easeInOut' as const;

type TransitionPhase = 'entering' | 'focused' | 'exiting';
type StoppableAnimation = { stop: () => void; then: PromiseLike<unknown>['then'] };

export interface FocusTransitionOverlayHandle {
  exit: (onComplete: () => boolean) => void;
}

interface Props {
  imageUrl: string | null;
  sourcePresentation: FocusTransitionImagePresentation | null;
  destinationPresentation: FocusTransitionImagePresentation | null;
  getDestinationPresentation?: () => FocusTransitionImagePresentation | null;
  animateEntry?: boolean;
  children: ReactNode;
  className?: string;
  backdropClassName?: string;
  testId?: string;
}

function containerStageRect(element: HTMLElement): StageRect {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.left,
    y: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
}

export const FocusTransitionOverlay = forwardRef<FocusTransitionOverlayHandle, Props>(
  function FocusTransitionOverlay(
    {
      imageUrl,
      sourcePresentation,
      destinationPresentation,
      getDestinationPresentation,
      animateEntry = true,
      children,
      className = '',
      backdropClassName = 'bg-background',
      testId = 'focus-transition-overlay',
    },
    ref,
  ) {
    const [scope, animate] = useAnimate();
    const reducedMotion = useReducedMotion();
    const imageLeft = useMotionValue(0);
    const imageTop = useMotionValue(0);
    const imageWidth = useMotionValue(0);
    const imageHeight = useMotionValue(0);
    const imageRotation = useMotionValue(0);
    const setTransitionImagePresentation = useCallback(
      (element: HTMLImageElement, presentation: FocusTransitionImagePresentation) => {
        imageLeft.set(presentation.rect.x);
        imageTop.set(presentation.rect.y);
        imageWidth.set(presentation.rect.width);
        imageHeight.set(presentation.rect.height);
        imageRotation.set(presentation.rotationDegrees);
        element.style.left = `${presentation.rect.x}px`;
        element.style.top = `${presentation.rect.y}px`;
        element.style.width = `${presentation.rect.width}px`;
        element.style.height = `${presentation.rect.height}px`;
        element.style.transform = `rotate(${presentation.rotationDegrees}deg)`;
      },
      [imageHeight, imageLeft, imageRotation, imageTop, imageWidth],
    );
    const [phase, setPhase] = useState<TransitionPhase>('entering');
    const phaseRef = useRef<TransitionPhase>('entering');
    const mountedRef = useRef(true);
    const activeAnimationsRef = useRef<StoppableAnimation[]>([]);
    const sourcePresentationRef = useRef(sourcePresentation);
    const destinationPresentationRef = useRef(destinationPresentation);
    const destinationPresentationGetterRef = useRef(getDestinationPresentation);

    sourcePresentationRef.current = sourcePresentation;
    destinationPresentationRef.current = destinationPresentation;
    destinationPresentationGetterRef.current = getDestinationPresentation;
    const sourceReady = sourcePresentation !== null;
    const destinationReady = destinationPresentation !== null;

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        for (const animation of activeAnimationsRef.current) animation.stop();
        activeAnimationsRef.current = [];
      };
    }, []);

    useLayoutEffect(() => {
      if (phaseRef.current !== 'entering' || !scope.current) return;
      const root = scope.current as HTMLElement;
      const backdrop = root.querySelector<HTMLElement>('[data-focus-transition-backdrop]');
      const transitionImage = root.querySelector<HTMLImageElement>('[data-focus-transition-image]');
      const destination = root.querySelector<HTMLElement>('[data-focus-transition-destination]');
      if (!backdrop || !transitionImage || !destination) return;

      if (!animateEntry) {
        backdrop.style.opacity = '1';
        transitionImage.style.opacity = '0';
        destination.style.opacity = '1';
        phaseRef.current = 'focused';
        setPhase('focused');
        return;
      }
      if (!destinationReady) return;

      const sourceScreen = sourcePresentationRef.current;
      const destinationScreen = destinationPresentationRef.current;
      if (!destinationScreen) return;
      if (!imageUrl || !sourceReady || !sourceScreen) {
        backdrop.style.opacity = '1';
        transitionImage.style.opacity = '0';
        destination.style.opacity = '1';
        phaseRef.current = 'focused';
        setPhase('focused');
        return;
      }

      const container = containerStageRect(root);
      const source = screenPresentationToLocal(sourceScreen, container);
      const target = screenPresentationToLocal(destinationScreen, container);
      setTransitionImagePresentation(transitionImage, source);
      backdrop.style.opacity = '0';
      transitionImage.style.opacity = '0';
      destination.style.opacity = '0';

      if (reducedMotion) {
        backdrop.style.opacity = '1';
        transitionImage.style.opacity = '0';
        destination.style.opacity = '1';
        phaseRef.current = 'focused';
        setPhase('focused');
        return;
      }

      let cancelled = false;
      const run = async () => {
        let animations = [
          animate(backdrop, { opacity: 1 }, { duration: COVER_SECONDS, ease: EASING }),
          animate(transitionImage, { opacity: 1 }, { duration: COVER_SECONDS, ease: EASING }),
        ] as StoppableAnimation[];
        activeAnimationsRef.current = animations;
        await Promise.all(animations);
        if (cancelled || !mountedRef.current) return;

        animations = [
          animateMotion(imageLeft, target.rect.x, {
            duration: IMAGE_MOVE_SECONDS,
            ease: EASING,
          }),
          animateMotion(imageTop, target.rect.y, {
            duration: IMAGE_MOVE_SECONDS,
            ease: EASING,
          }),
          animateMotion(imageWidth, target.rect.width, {
            duration: IMAGE_MOVE_SECONDS,
            ease: EASING,
          }),
          animateMotion(imageHeight, target.rect.height, {
            duration: IMAGE_MOVE_SECONDS,
            ease: EASING,
          }),
          animateMotion(imageRotation, target.rotationDegrees, {
            duration: IMAGE_MOVE_SECONDS,
            ease: EASING,
          }),
        ] as StoppableAnimation[];
        activeAnimationsRef.current = animations;
        await Promise.all(animations);
        if (cancelled || !mountedRef.current) return;

        animations = [
          animate(destination, { opacity: 1 }, { duration: EDITOR_FADE_SECONDS, ease: EASING }),
        ] as StoppableAnimation[];
        activeAnimationsRef.current = animations;
        await Promise.all(animations);
        if (cancelled || !mountedRef.current) return;

        activeAnimationsRef.current = [];
        phaseRef.current = 'focused';
        setPhase('focused');
      };

      void run();
      return () => {
        cancelled = true;
        for (const animation of activeAnimationsRef.current) animation.stop();
        activeAnimationsRef.current = [];
      };
    }, [
      animate,
      animateEntry,
      destinationReady,
      imageHeight,
      imageLeft,
      imageRotation,
      imageTop,
      imageUrl,
      imageWidth,
      reducedMotion,
      scope,
      setTransitionImagePresentation,
      sourceReady,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        exit(onComplete) {
          if (phaseRef.current !== 'focused' || !scope.current) return;
          const sourceScreen = sourcePresentationRef.current;
          const destinationScreen =
            destinationPresentationGetterRef.current?.() ?? destinationPresentationRef.current;
          if (!sourceScreen || !destinationScreen) {
            onComplete();
            return;
          }

          const root = scope.current as HTMLElement;
          const backdrop = root.querySelector<HTMLElement>('[data-focus-transition-backdrop]');
          const transitionImage = root.querySelector<HTMLImageElement>(
            '[data-focus-transition-image]',
          );
          const destination = root.querySelector<HTMLElement>(
            '[data-focus-transition-destination]',
          );
          if (!backdrop || !transitionImage || !destination) {
            onComplete();
            return;
          }

          phaseRef.current = 'exiting';
          setPhase('exiting');
          const container = containerStageRect(root);
          const source = screenPresentationToLocal(sourceScreen, container);
          const currentDestination = screenPresentationToLocal(destinationScreen, container);

          // Reposition the transition image underneath the still-opaque destination editor before
          // fading that editor. The duplicate is therefore never independently visible.
          setTransitionImagePresentation(transitionImage, currentDestination);
          transitionImage.style.opacity = '1';
          backdrop.style.opacity = '1';

          const restoreFocused = () => {
            transitionImage.style.opacity = '0';
            backdrop.style.opacity = '1';
            destination.style.opacity = '1';
            phaseRef.current = 'focused';
            setPhase('focused');
          };

          if (reducedMotion) {
            destination.style.opacity = '0';
            transitionImage.style.opacity = '0';
            backdrop.style.opacity = '0';
            if (!onComplete()) restoreFocused();
            return;
          }

          const run = async () => {
            let animations = [
              animate(destination, { opacity: 0 }, { duration: EDITOR_FADE_SECONDS, ease: EASING }),
            ] as StoppableAnimation[];
            activeAnimationsRef.current = animations;
            await Promise.all(animations);
            if (!mountedRef.current) return;

            animations = [
              animateMotion(imageLeft, source.rect.x, {
                duration: IMAGE_MOVE_SECONDS,
                ease: EASING,
              }),
              animateMotion(imageTop, source.rect.y, {
                duration: IMAGE_MOVE_SECONDS,
                ease: EASING,
              }),
              animateMotion(imageWidth, source.rect.width, {
                duration: IMAGE_MOVE_SECONDS,
                ease: EASING,
              }),
              animateMotion(imageHeight, source.rect.height, {
                duration: IMAGE_MOVE_SECONDS,
                ease: EASING,
              }),
              animateMotion(imageRotation, source.rotationDegrees, {
                duration: IMAGE_MOVE_SECONDS,
                ease: EASING,
              }),
            ] as StoppableAnimation[];
            activeAnimationsRef.current = animations;
            await Promise.all(animations);
            if (!mountedRef.current) return;

            animations = [
              animate(transitionImage, { opacity: 0 }, { duration: COVER_SECONDS, ease: EASING }),
              animate(backdrop, { opacity: 0 }, { duration: COVER_SECONDS, ease: EASING }),
            ] as StoppableAnimation[];
            activeAnimationsRef.current = animations;
            await Promise.all(animations);
            if (!mountedRef.current) return;

            activeAnimationsRef.current = [];
            if (!onComplete()) restoreFocused();
          };
          void run();
        },
      }),
      [
        animate,
        imageHeight,
        imageLeft,
        imageRotation,
        imageTop,
        imageWidth,
        reducedMotion,
        scope,
        setTransitionImagePresentation,
      ],
    );

    return (
      <div
        ref={scope}
        className={`absolute inset-0 ${phase === 'focused' ? '' : 'pointer-events-none'} ${className}`}
        data-focus-transition=""
        data-focus-transition-phase={phase}
        data-testid={testId}
      >
        <div
          className={`pointer-events-none absolute inset-0 z-0 opacity-0 ${backdropClassName}`}
          data-focus-transition-backdrop=""
        />
        <motion.img
          src={imageUrl ?? undefined}
          alt=""
          className="pointer-events-none absolute z-10 max-w-none opacity-0"
          style={{
            left: imageLeft,
            top: imageTop,
            width: imageWidth,
            height: imageHeight,
            rotate: imageRotation,
            transformOrigin: 'center',
          }}
          data-focus-transition-image=""
        />
        <div className="absolute inset-0 z-20 opacity-0" data-focus-transition-destination="">
          {children}
        </div>
      </div>
    );
  },
);
