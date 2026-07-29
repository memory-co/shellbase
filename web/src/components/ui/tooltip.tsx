import { Tooltip as BaseTooltip } from "@base-ui-components/react/tooltip";
import * as React from "react";
import { cn } from "@/lib/utils";

const TooltipProvider = ({
  delay = 300,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Provider>) => (
  <BaseTooltip.Provider delay={delay} {...props} />
);
const Tooltip = BaseTooltip.Root;
const TooltipTrigger = BaseTooltip.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof BaseTooltip.Popup>,
  React.ComponentPropsWithoutRef<typeof BaseTooltip.Popup> & {
    sideOffset?: number;
  }
>(({ className, sideOffset = 6, ...props }, ref) => (
  <BaseTooltip.Portal>
    <BaseTooltip.Positioner sideOffset={sideOffset} className="z-50">
      <BaseTooltip.Popup
        ref={ref}
        className={cn(
          "overflow-hidden rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
          className,
        )}
        {...props}
      />
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>
));
TooltipContent.displayName = "TooltipContent";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
