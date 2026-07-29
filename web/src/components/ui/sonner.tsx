import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "!bg-popover !text-popover-foreground !border-border !rounded-md !text-sm",
          description: "!text-muted-foreground",
        },
      }}
    />
  );
}

export { toast } from "sonner";
