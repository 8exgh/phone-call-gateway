/**
 * Overlay area codes: codes that serve the same city/region as the requested
 * one. When the requested code has no inventory, these are the "as close as
 * possible" fallbacks (e.g. Winnipeg's 204 is usually dry on providers while
 * its overlay 431 has stock). Curated for Canadian metros plus the regions
 * this gateway is likely to serve; extend as needed.
 */
export const AREA_CODE_OVERLAYS: Record<string, string[]> = {
  // Manitoba (Winnipeg)
  '204': ['431', '584'],
  '431': ['204', '584'],
  '584': ['204', '431'],
  // Alberta (Calgary/Edmonton)
  '403': ['587', '825', '368'],
  '780': ['587', '825', '368'],
  '587': ['403', '780', '825', '368'],
  '825': ['587', '403', '780', '368'],
  // Saskatchewan
  '306': ['639', '474'],
  '639': ['306', '474'],
  // Toronto
  '416': ['647', '437'],
  '647': ['416', '437'],
  '437': ['416', '647'],
  // Greater Toronto / Golden Horseshoe
  '905': ['289', '365', '742'],
  // Vancouver / BC
  '604': ['778', '236', '672'],
  '778': ['604', '236', '672'],
  '250': ['778', '236', '672'],
  // Montreal
  '514': ['438', '263'],
  '438': ['514', '263'],
  // Ottawa
  '613': ['343', '753'],
  // Atlantic
  '902': ['782'],
  '506': ['428'],
};

/** The requested code first, then its same-region overlays. */
export function areaCodeCandidates(areaCode: string): string[] {
  return [areaCode, ...(AREA_CODE_OVERLAYS[areaCode] ?? [])];
}
