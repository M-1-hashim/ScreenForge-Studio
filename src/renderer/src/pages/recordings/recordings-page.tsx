import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLibraryStore } from '@/stores/library-store'
import { RecordingCard } from '@/components/shared/recording-card'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatBytes } from '@/lib/utils'
import { Clapperboard, RefreshCw, Search } from 'lucide-react'

type SortKey = 'newest' | 'oldest' | 'largest'

export function RecordingsPage() {
  const navigate = useNavigate()
  const { recordings, storage, loading, load } = useLibraryStore()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('newest')

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? recordings.filter((r) => r.title.toLowerCase().includes(q)) : [...recordings]
    switch (sort) {
      case 'oldest':
        return list.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1))
      case 'largest':
        return list.sort((a, b) => b.sizeBytes - a.sizeBytes)
      default:
        return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    }
  }, [recordings, query, sort])

  const openInEditor = (id: string) => navigate(`/editor?recording=${encodeURIComponent(id)}`)

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Recordings</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {recordings.length} recording{recordings.length === 1 ? '' : 's'}
            {storage ? ` · ${formatBytes(storage.recordingsBytes)} total` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles"
              className="h-9 w-52 pl-8"
              aria-label="Search recordings"
            />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-9 w-36" aria-label="Sort order">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="largest">Largest first</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title={query ? 'No matching recordings' : 'Nothing recorded yet'}
          description={
            query
              ? 'Try a different search term.'
              : 'Record your screen and finished captures will be organized here.'
          }
          actionLabel={query ? undefined : 'Start recording'}
          onAction={query ? undefined : () => navigate('/recorder')}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((rec) => (
            <RecordingCard key={rec.id} recording={rec} onOpenEditor={openInEditor} />
          ))}
        </div>
      )}
    </div>
  )
}
