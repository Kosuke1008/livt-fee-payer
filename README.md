# LivT Fee Payer

LivTのJPYC決済手数料を負担する、セルフホスト型のFee Payerサービスです。

LivT Walletがブラウザ内で署名したtransactionへFee Payer署名を追加し、Kaia
Kairosへbroadcastします。Kaia管理Fee Delegation ServiceやUnifi APIは使用しません。

> 現在はKairos実証専用です。Mainnetでは使用できません。

## 処理フロー

```text
LivT Wallet
  └─ sender署名（Wallet秘密情報は端末外へ出さない）
       ↓
LivT Laravel
  └─ 決済内容とsender署名を検証
       ↓ 127.0.0.1 + 内部Bearer
LivT Fee Payer
  ├─ transaction policyを再検証
  ├─ 専用Fee Payer鍵で追加署名
  ├─ Kairosへ1回だけbroadcast
  └─ receiptを確認
       ↓ transaction hash
LivT Laravel
  └─ 既存の共通verifierでreceiptとJPYC Transferを再検証して決済確定
```

## セキュリティ境界

- `127.0.0.1`だけで待ち受け、外部公開しません。
- Walletのmnemonic、秘密鍵、パスワード、復号済み情報を受け取りません。
- 専用Fee Payer秘密鍵はこのサービスの`.env`だけに保存します。
- sender署名済みRLPとFee Payer署名済みRLPをログへ出しません。
- Kairos、transaction type `0x31`、JPYC contract、ERC-20 `transfer`、value 0、
  gas上限、署名前後のfieldを検証します。
- broadcastは自動retryしません。新しいtransactionを作らないreceipt pollingだけを
  行います。

## セットアップ

Node.jsとCorepackを用意し、Kairos専用Fee Payer EOAを作成します。

```bash
corepack pnpm install
corepack pnpm setup:kairos
```

`setup:kairos`は次の動作だけを行います。

- 新しいKairos専用EOAを生成
- 秘密鍵をmode `0600`の`.env`へ保存
- terminalには公開アドレスだけを表示
- 既存の`.env`がある場合は上書きせず終了

表示された公開アドレスへKairos Faucetから必要最小限のKAIAを入れてください。
既存ユーザーWallet、Mainnet鍵、LivT Walletのmnemonicは流用しないでください。

## テスト

```bash
corepack pnpm test
corepack pnpm typecheck
```

テストはHTTP fakeとoffline署名を使用し、実Kairosへbroadcastしません。

## Kairos手動レビュー

LivT Walletのreview runnerがLaravel、Wallet、Fee Payerをまとめて起動します。
runnerは起動ごとに内部Bearerを生成するため、外部API keyの取得や`.env`への記載は
不要です。

```bash
cd ../livt-wallet
corepack pnpm review:kairos-fee-delegated-live
```

## Mainnetについて

Mainnetでは、少なくとも次の対応が完了するまで有効化しません。

- Fee Payer秘密鍵をKMS/HSMへ移行
- 永続的な冪等性と結果不明transactionの復旧
- 利用上限、rate limit、監査ログ、残高監視、緊急停止
- Mainnet用chain・contract・RPC・鍵の完全分離
- transaction policyと鍵運用の独立セキュリティレビュー
