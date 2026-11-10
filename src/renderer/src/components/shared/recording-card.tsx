import { formatBytes, formatDate } from '@/lib/utils'
import { formatTimecode } from '@shared/edl'
import type { RecordingMeta } from '@shared/types'
import { cn } from '@/lib/utils'
import {
  AppWindow,
  EllipsisVertical,
  Film,
  FolderOpen,
  Monitor,
  Pencil,
  Play,
  Scissors,
  SquareDashed,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { useLibraryStore } from '@/stores/library-store'
import { toast } from '@/stores/toast-store'
import { useNavigate } from 'react-router-dom'

const MODE_ICONS = {
  fullscreen: Monitor,
  region: SquareDashed,
  window: AppWindow,
} as const

export function RecordingCard({
  recording,
  onOpenEditor,
}: {
  recording: RecordingMeta
  onOpenEditor: (id: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(recording.title)
  const remove = useLibraryStore((s) => s.remove)
  const rename = useLibraryStore((s) => s.rename)

  const ModeIcon = MODE_ICONS[recording.mode] ?? Monitor

  return (
    <div className="group overflow-hidden rounded-lg border bg-card transition-colors hover:border-primary/40">
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-900">
        {recording.thumbnailPath ? (
          <img
            src={`recfile://media/${encodeURIComponent(recording.thumbnailPath)}`}
            alt={recording.title}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-600">
            <Film className="h-10 w-10" />
          </div>
        )}
        <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white">
          {formatTimecode(recording.durationMs, false)}
        </span>
        <span
          className="absolute left-2 top-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200"
          title={recording.mode}
        >
          <ModeIcon className="h-3 w-3" />
          {recording.mode}
        </span>
      </div>
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={recording.title}>
            {recording.title}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {formatDate(recording.createdAt)} · {formatBytes(recording.sizeBytes)}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Recording actions">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onOpenEditor(recording.id)}>
              <Scissors className="mr-2 h-4 w-4" /> Open in Editor
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void window.screenforge.shell.openPath(recording.videoPath)}>
              <Play className="mr-2 h-4 w-4" /> Play (system player)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void window.screenforge.shell.revealPath(recording.videoPath)}>
              <FolderOpen className="mr-2 h-4 w-4" /> Reveal in Folder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil className="mr-2 h-4 w-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
            <AlertDialogDescription>
              “{recording.title}” and its project files will be removed permanently. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn('bg-destructive text-destructive-foreground hover:bg-destructive/90')}
              onClick={() => {
                void remove(recording.id).then(() => toast.success('Recording deleted'))
                setConfirmDelete(false)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename recording</DialogTitle>
          </DialogHeader>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const title = renameValue.trim()
                if (title) {
                  void rename(recording.id, title)
                  toast.success('Renamed')
                }
                setRenaming(false)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
