import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const Dialog = BaseDialog.Root;
const DialogTrigger = BaseDialog.Trigger;
const DialogClose = BaseDialog.Close;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof BaseDialog.Popup>,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Popup> & {
    showClose?: boolean;
  }
>(({ className, children, showClose = true, ...props }, ref) => (
  <BaseDialog.Portal>
    <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-all duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
    <BaseDialog.Popup
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-lg transition-all duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
        className,
      )}
      {...props}
    >
      {children}
      {showClose && (
        <BaseDialog.Close className="absolute right-3 top-3 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
          <X className="h-4 w-4" />
        </BaseDialog.Close>
      )}
    </BaseDialog.Popup>
  </BaseDialog.Portal>
));
DialogContent.displayName = "DialogContent";

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1.5", className)} {...props} />
);

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof BaseDialog.Title>,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Title>
>(({ className, ...props }, ref) => (
  <BaseDialog.Title
    ref={ref}
    className={cn("text-base font-semibold", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof BaseDialog.Description>,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Description>
>(({ className, ...props }, ref) => (
  <BaseDialog.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
};
