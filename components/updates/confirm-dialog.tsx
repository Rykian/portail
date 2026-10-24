"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NeedsConfirmResponse } from "@/shared/updater-api";

export type Confirmation =
  | { kind: "update"; stack: string; details: NeedsConfirmResponse["needsConfirm"] }
  | { kind: "rollback"; stack: string; to: string };

export function ConfirmDialog({
  confirmation,
  onConfirm,
  onCancel,
}: {
  confirmation: Confirmation | null;
  onConfirm: (confirmation: Confirmation) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={confirmation !== null} onOpenChange={(open) => !open && onCancel()}>
      {confirmation && (
        <DialogContent className="sm:max-w-2xl">
          {confirmation.kind === "update" ? (
            <>
              <DialogTitle>Mettre à jour {confirmation.stack} ?</DialogTitle>
              <DialogDescription>
                {confirmation.details.from ?? "?"} → {confirmation.details.to ?? "?"}
              </DialogDescription>
              {confirmation.details.diff && (
                <pre
                  aria-label="Différences"
                  className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap"
                >
                  {confirmation.details.diff}
                </pre>
              )}
              {confirmation.details.warning && <p className="text-destructive">{confirmation.details.warning}</p>}
            </>
          ) : (
            <>
              <DialogTitle>Revenir à {confirmation.to} ?</DialogTitle>
              <DialogDescription>{confirmation.stack} reprendra sa version précédente.</DialogDescription>
            </>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
            <Button onClick={() => onConfirm(confirmation)}>Confirmer</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
