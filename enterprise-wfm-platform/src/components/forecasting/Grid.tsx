/**
 * AG Grid Community (MIT licence), themed to the platform palette. Nothing here needs a licence key: no screen uses a paid (Enterprise) feature, and the
 * Enterprise package is not installed, so there is no evaluation watermark and nothing to buy for a production build.
 */
import React from 'react';
import { AgGridReact, AgGridReactProps } from 'ag-grid-react';
import {
  ModuleRegistry, themeQuartz, ClientSideRowModelModule, ClientSideRowModelApiModule, InfiniteRowModelModule, RowSelectionModule, CellStyleModule, RowStyleModule,
  TextEditorModule, NumberEditorModule, CheckboxEditorModule, SelectEditorModule, LargeTextEditorModule, CustomEditorModule, TextFilterModule, NumberFilterModule,
  DateFilterModule, QuickFilterModule, ExternalFilterModule, ColumnAutoSizeModule, PinnedRowModule, ColumnApiModule, RenderApiModule, CellApiModule, RowApiModule,
  ScrollApiModule, EventApiModule, TooltipModule, ValidationModule, LocaleModule, PaginationModule, RowAutoHeightModule,
} from 'ag-grid-community';

// Only what the screens use (the full community bundle also carries export, undo/redo, drag-and-drop and more that nothing here needs): a smaller download on first load.
ModuleRegistry.registerModules([
  ClientSideRowModelModule, ClientSideRowModelApiModule, InfiniteRowModelModule, RowSelectionModule, CellStyleModule, RowStyleModule,
  TextEditorModule, NumberEditorModule, CheckboxEditorModule, SelectEditorModule, LargeTextEditorModule, CustomEditorModule, TextFilterModule, NumberFilterModule,
  DateFilterModule, QuickFilterModule, ExternalFilterModule, ColumnAutoSizeModule, PinnedRowModule, ColumnApiModule, RenderApiModule, CellApiModule, RowApiModule,
  ScrollApiModule, EventApiModule, TooltipModule, ValidationModule, LocaleModule, PaginationModule, RowAutoHeightModule,
]);

export const gridTheme = themeQuartz.withParams({
  fontFamily: 'inherit', fontSize: 13, foregroundColor: '#171717', backgroundColor: '#FFFFFF',
  borderColor: '#E5E5E0', headerBackgroundColor: '#FAFAF8', headerTextColor: '#737373', headerFontSize: 11, headerFontWeight: 600,
  oddRowBackgroundColor: '#FFFFFF', rowHoverColor: '#FAFAF8', accentColor: '#171717', wrapperBorderRadius: 8,
});

export function Grid<T>({ height = 420, ...props }: AgGridReactProps<T> & { height?: number }) {
  return (
    <div style={{ height, width: '100%' }}>
      <AgGridReact<T> theme={gridTheme} animateRows={false} suppressCellFocus {...props} />
    </div>
  );
}
