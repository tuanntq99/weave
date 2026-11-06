/** What the trash offers for a page: bringing it back and deleting it for
 *  good are both changes, so neither is offered where the page can only be
 *  viewed. */
export function trashActions(canEdit: boolean): { restore: boolean; deletePermanently: boolean } {
  return { restore: canEdit, deletePermanently: canEdit };
}
