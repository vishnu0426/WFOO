# How screens wait

One set of rules so every screen behaves the same. The pieces are in `src/components/common/loading.tsx`; data comes from `useApi` (`src/components/forecasting/hooks.ts`).

| Situation | What the person sees |
|---|---|
| First load of a table, cards or a page | Nothing for ~200 ms (a fast answer never flashes a skeleton), then a grey skeleton in the shape of the data. Once shown it stays ~400 ms, so it does not flicker. |
| Information already on screen is refreshed | The information stays, with a quiet "Updating…". |
| A refresh fails | The last information stays, with a warning and **Try again**. It is not wiped. |
| First load fails | An error card saying what could not be loaded, with **Try again**. |
| First load takes over ~10 s | "Still loading … This is taking longer than usual", with **Try again**. |
| Loaded, but nothing in it | The empty message ("No groups yet"). Never shown while still loading. |
| A save, delete or other action | The small spinner (`Busy`) on the button or beside it. |
| A long job (schedule generation) | Its own progress card. |

## Using it

```tsx
const groups = useApi<GroupDto[]>('/config/groups');
<LoadState state={groups} what="WFM groups" skeleton={<TableSkeleton rows={6} cols={8} />} isEmpty={(d) => d.length === 0} empty={<Empty title="No WFM groups yet" />}>
  {(list) => <GroupList groups={list} />}
</LoadState>
```

- `useApi` returns `{ data, error, loading, refreshing, reload, updatedAt }`. `loading` is true only while there is nothing to show yet; `refreshing` is a fetch behind information that is already shown; `reload()` asks again now.
- Where a screen cannot be wrapped easily, guard it the same way: `if (x.data === null) return <LoadState state={x} what="…">{() => null}</LoadState>;` before the code that reads `x.data`.
- Never write `list.length === 0 ? <Empty/> : <Table/>` on data that may still be loading: `data` is `null` then, and the empty message flashes.
- Skeletons: `TableSkeleton`, `CardsSkeleton`, `PageSkeleton`, `SkeletonLine`, `SkeletonBlock`. Not for buttons, menus, dialogs or toasts.

### Screens that already branch on loading themselves

Swap the spinner, don't restructure the screen:

```tsx
if (x.loading && !x.data) return <Waiting what="pay runs" shape="table" reload={x.reload} />;   // shape: table | cards | panel | lines
if (x.error && !x.data) return <LoadFailed what="pay runs" error={x.error} reload={x.reload} />;
...
<StaleNote state={x} what="pay runs" />   // screens that keep their data on screen: a failed refresh shows a warning + retry
```

A few `Busy` spinners are left on purpose: they sit beside work the server is really doing and say what it is doing ("Working out earlier days…", "Comparing…").

## Finding what is slow

Every request's time is kept in the browser tab. In the console, `__wfmTimings()` prints the slowest by average. Check it before polishing a screen.

Test: `backend/gateway/node_modules/.bin/tsx --test src/components/common/loading.test.ts` (from the project root).
