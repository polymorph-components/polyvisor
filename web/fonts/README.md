# Noto Emoji animal fallback

`noto-emoji-animals.woff2` is a static weight-400 subset of Google Noto Emoji,
covering the U+1F3B2 game die used by roll buttons, U+1F400..U+1F43F, and
U+FE0F. It is used only after installed native emoji fonts. Noto Emoji is
 Copyright 2013 Google LLC and licensed under the SIL Open Font License 1.1;
see `OFL.txt`.

Source: https://github.com/google/fonts/blob/809e4d8b8d7e9364a914909bb777679606c178b8/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf
at google/fonts revision
`809e4d8b8d7e9364a914909bb777679606c178b8`, SHA-256
`de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`.

Regenerate with fontTools 4.55.3:

```sh
python3 -c 'from fontTools.ttLib import TTFont; from fontTools.varLib.instancer import instantiateVariableFont; f=TTFont("NotoEmoji[wght].ttf"); instantiateVariableFont(f,{"wght":400},inplace=True); f.save("NotoEmoji-400.ttf")'
python3 -m fontTools.subset NotoEmoji-400.ttf --output-file=noto-emoji-animals.woff2 --flavor=woff2 --unicodes=U+1F3B2,U+1F400-1F43F,U+FE0F --layout-features='*' --name-IDs='*' --name-legacy --name-languages='*' --notdef-glyph --notdef-outline --recommended-glyphs --drop-tables=DSIG
```
