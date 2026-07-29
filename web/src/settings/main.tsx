import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { AppProviders } from "@/lib/query";
import { useEnv, usePutEnv } from "@/lib/queries";

const SUGGESTED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

function SettingsApp() {
  const { data, isLoading } = useEnv();
  const put = usePutEnv();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const vars = data?.vars ?? {};
  const missing = SUGGESTED.filter((k) => !(k in vars));

  const save = (k: string, v: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      toast.error("变量名不合法", { description: "只允许字母、数字和下划线" });
      return;
    }
    put.mutate(
      { [k]: v },
      {
        onSuccess: () => {
          setKey("");
          setValue("");
          toast.success("已保存", { description: "对新打开的终端生效" });
        },
        onError: () => toast.error("保存失败"),
      },
    );
  };

  const remove = (k: string) =>
    put.mutate({ [k]: null }, { onSuccess: () => toast.success(`已删除 ${k}`) });

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 overflow-auto p-6 scrollbar-thin">
      <div>
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <KeyRound className="h-4 w-4 text-primary" />
          全局环境变量
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          这里配置的变量会注入到之后新打开的终端里（已开着的终端不受影响，关闭重开即可生效）。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">新增 / 覆盖</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="k">变量名</Label>
              <Input
                id="k"
                className="mt-1 font-mono"
                placeholder="ANTHROPIC_API_KEY"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
            <div className="flex-[2]">
              <Label htmlFor="v">值</Label>
              <Input
                id="v"
                type="password"
                className="mt-1 font-mono"
                placeholder="sk-…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save(key, value)}
              />
            </div>
          </div>
          {missing.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">常用：</span>
              {missing.map((k) => (
                <Button
                  key={k}
                  variant="outline"
                  size="sm"
                  onClick={() => setKey(k)}
                >
                  <Plus className="h-3 w-3" />
                  {k}
                </Button>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              onClick={() => save(key, value)}
              disabled={!key || !value || put.isPending}
            >
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <Label className="mb-2 block">已配置</Label>
        {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
        {!isLoading && Object.keys(vars).length === 0 && (
          <p className="text-sm text-muted-foreground">还没有配置任何变量</p>
        )}
        <div className="flex flex-col gap-1">
          {Object.entries(vars).map(([k, v]) => (
            <div
              key={k}
              className="group flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <span className="font-mono text-sm">{k}</span>
              <Badge variant="outline" className="font-mono">
                {v.preview}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {v.length} 字符
              </span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => remove(k)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProviders>
    <SettingsApp />
  </AppProviders>,
);
