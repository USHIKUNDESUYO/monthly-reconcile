# 月次照合のソースからHTMLを再生成する

利用するだけなら、同梱のHTMLを開けます。再生成には既存のPython 3を使います。ライブラリの追加は必要ありません。

ZIPを展開したフォルダーで、次のコマンドを実行すると`dist/monthly-reconcile.html`を作成します。既存の出力が同じ内容ならそのままにし、内容が異なる場合は上書きせず終了します。

```powershell
python build.py
```

次のコマンドで、元のHTMLと再生成したHTMLのSHA-256を比較してください。ソースを変更していなければ、両方のハッシュが一致します。

```powershell
Get-FileHash -Algorithm SHA256 monthly-reconcile.html
Get-FileHash -Algorithm SHA256 dist/monthly-reconcile.html
```

既存のNode.jsがある場合は、次のコマンドで判定と保存の試験を実行できます。追加パッケージを使わず、Node.jsの組み込み機能だけで動きます。

```powershell
node --test tests/core.test.cjs tests/app.test.cjs
```

`fixtures`のCSVと期待分類は架空の試験例です。試験で比較する期待分類は、一般の会計判断や実務の正解を保証するものではありません。試験の合格と、ブラウザーの操作・組織での運用条件の確認は別の作業です。

`SHA256SUMS`には、配布したファイルのハッシュを記載しています。ハッシュの一致は内容が同じであることを示します。配布者の本人認証や電子署名としては使いません。
