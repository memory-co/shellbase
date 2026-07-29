import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 py-1.5",
        sm: "h-7 rounded-md px-2 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-8 w-8",
        "icon-sm": "h-6 w-6 rounded",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 把样式套到子元素上（如 <a>），对应 Base UI 的 render 语义 */
  render?: React.ReactElement;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, render, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }));
    if (render) {
      return React.cloneElement(
        render,
        {
          ...props,
          ref,
          className: cn(classes, render.props.className),
        } as React.HTMLAttributes<HTMLElement>,
      );
    }
    return <button ref={ref} className={classes} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
