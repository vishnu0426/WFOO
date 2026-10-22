/**
 * AG Grid Enterprise, themed to the platform palette. The licence key is read from VITE_AG_GRID_LICENSE;
 * without it the grid still works but shows AG Grid's evaluation watermark.
 */
import React from 'react';
import { AgGridReact, AgGridReactProps } from 'ag-grid-react';
import { AllEnterpriseModule, LicenseManager, ModuleRegistry, themeQuartz } from 'ag-grid-enterprise';

ModuleRegistry.registerModules([AllEnterpriseModule]);
const licence = (import.meta as any).env?.VITE_AG_GRID_LICENSE as string | undefined;
if (licence) LicenseManager.setLicenseKey(licence);

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
