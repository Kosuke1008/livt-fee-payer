# LivT Fee Payer

KairosでLivTのJPYC決済手数料を負担する、ローカル専用のFee Payer
sidecarです。Kaia管理Fee Delegation ServiceやUnifi APIは使用しません。

## セキュリティ境界

- `127.0.0.1`だけで待ち受けます。
- LivT Walletの秘密鍵、mnemonic、Walletパスワードは受け取りません。
- 専用Fee Payer秘密鍵はこのserviceの`.env`だけに置きます。
- sender署名済みRLPと完全RLPをログへ出しません。
- broadcastは自動retryしません。receipt確認のpollingだけを行います。
- Kairos、`0x31`、JPYC、ERC-20 `transfer`、value 0、gas上限を固定検証します。

## Kairos実証準備

1. 依存関係をインストールします。
2. 次の初期化コマンドで新しいKairos専用EOAを作成します。秘密鍵はmode `0600`の`.env`だけへ保存され、terminalには公開アドレスだけを表示します。
3. 表示された公開アドレスへKairos Faucetから必要最小限のKAIAを入れます。
4. テストを実行します。

```bash
corepack pnpm install
corepack pnpm setup:kairos
corepack pnpm test
corepack pnpm typecheck
```

`setup:kairos`は既存の`.env`を上書きしません。既存ユーザーWallet、Mainnet鍵、
LivT WalletのmnemonicをFee Payerとして流用しないでください。

通常はLivT Walletのlive runnerが一時的な内部APIキーを生成し、このsidecar、
Laravel、Walletをまとめて起動します。内部APIキーやFee Payer秘密鍵をブラウザへ
渡すことはありません。

```bash
cd /home/kosuke/projects/livt-wallet
corepack pnpm review:kairos-fee-delegated-live
```

この実装はKairos実証限定です。MainnetではFee Payer署名をKMS/HSMへ移し、
永続的な冪等性、利用上限、監査、残高監視を追加するまで有効化しません。
