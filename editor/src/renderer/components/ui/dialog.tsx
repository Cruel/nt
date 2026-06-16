import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

type DialogProps = ComponentProps<typeof BaseDialog.Root>;

function Dialog({ children, ...props }: DialogProps) {
  return <BaseDialog.Root {...props}>{children}</BaseDialog.Root>;
}

type DialogTriggerProps = ComponentProps<typeof BaseDialog.Trigger>;

function DialogTrigger({ className, ...props }: DialogTriggerProps) {
  return <BaseDialog.Trigger className={cn(className)} {...props} />;
}

interface DialogPopupProps extends ComponentProps<typeof BaseDialog.Popup> {
  children: ReactNode;
}

function DialogPopup({ className, children, ...props }: DialogPopupProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/80 data-[ending-style]:fade-out data-[starting-style]:fade-in data-[ending-style]:duration-200 data-[starting-style]:duration-200" />
      <BaseDialog.Popup
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 sm:rounded-lg',
          className,
        )}
        {...props}
      >
        {children}
        <BaseDialog.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </BaseDialog.Close>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

type DialogTitleProps = ComponentProps<typeof BaseDialog.Title>;

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <BaseDialog.Title
      className={cn(
        'text-lg font-semibold leading-none tracking-tight',
        className,
      )}
      {...props}
    />
  );
}

type DialogDescriptionProps = ComponentProps<typeof BaseDialog.Description>;

function DialogDescription({
  className,
  ...props
}: DialogDescriptionProps) {
  return (
    <BaseDialog.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogTitle,
  DialogDescription,
};
