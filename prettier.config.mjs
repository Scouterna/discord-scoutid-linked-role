/**
 * Prettier configuration — deliberately empty of overrides.
 *
 * Every default is already right for this tree, which is why adopting Prettier
 * cost 864 changed lines rather than a rewrite: the code was hand-written at
 * roughly 80 columns with double quotes and semicolons, so `printWidth: 80` and
 * the rest were effectively in force already. Writing them out here would only
 * create something to drift from.
 *
 * `endOfLine` matters and is also the default (`"lf"`): several files were CRLF
 * in the working copy, which .gitattributes normalises on commit but which
 * showed up as whole-file diffs locally.
 *
 * What is *not* formatted is in .prettierignore, and the markdown entry there is
 * the interesting one.
 */
export default {};
