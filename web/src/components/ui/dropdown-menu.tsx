import { Menu } from "@base-ui-components/react/menu";
import * as React from "react";
import { cn } from "@/lib/utils";

const DropdownMenu = Menu.Root;
const DropdownMenuTrigger = Menu.Trigger;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof Menu.Popup>,
  React.ComponentPropsWithoutRef<typeof Menu.Popup> & {
    sideOffset?: number;
    align?: "start" | "center" | "end";
  }
>(({ className, sideOffset = 4, align = "start", ...props }, ref) => (
  <Menu.Portal>
    <Menu.Positioner sideOffset={sideOffset} align={align} className="z-50">
      <Menu.Popup
        ref={ref}
        className={cn(
          "min-w-[10rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md transition-all duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
          className,
        )}
        {...props}
      />
    </Menu.Positioner>
  </Menu.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof Menu.Item>,
  React.ComponentPropsWithoutRef<typeof Menu.Item>
>(({ className, ...props }, ref) => (
  <Menu.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof Menu.Separator>,
  React.ComponentPropsWithoutRef<typeof Menu.Separator>
>(({ className, ...props }, ref) => (
  <Menu.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof Menu.GroupLabel>,
  React.ComponentPropsWithoutRef<typeof Menu.GroupLabel>
>(({ className, ...props }, ref) => (
  <Menu.GroupLabel
    ref={ref}
    className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
};
