# LivT Fee Payer

LivTのJPYC決済手数料を負担する、セルフホスト型のFee Payerサービスです。

LivT Walletがブラウザ内で署名したtransactionへFee Payer署名を追加し、Kaia
Kairosへbroadcastします。Kaia Managed Fee DelegationはLaravel側の将来選択肢として
残しますが、このserviceから自動fallbackしません。

> 現在はKairos実証専用です。Mainnetでは使用できません。

ネットワークはapplication環境から推測せず、`BLOCKCHAIN_NETWORK=kairos`で
明示します。`kaia-mainnet` profileもchain ID 8217、JPYC、explorer、RPCの
検証用metadataとして存在しますが、Phase 8でもサーバ起動・署名・broadcastを
常に拒否します。Mainnet profileのexecution/signing/broadcast policyはcode上でfalseです。

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
- Kairos local signerだけがprocess秘密鍵を利用します。Mainnetはexternal signer addressの
  構造確認のみで、KMS/HSM adapterやprocess local keyは実装していません。
- sender署名済みRLPとFee Payer署名済みRLPをログへ出しません。
- Kairos、transaction type `0x31`、JPYC contract、ERC-20 `transfer`、value 0、
  gas上限、署名前後のfieldを検証します。
- broadcastは自動retryしません。新しいtransactionを作らないreceipt pollingだけを
  行います。
- kill switchと最低KAIA reserveは署名前に検査します。
- Mainnet primary RPCは専用providerを要求し、secondary RPCはread-onlyです。broadcast
  failoverには使いません。
- `FEE_PAYER_SKIP_KAIROS_CHECK=1`は、非productionのKairosで
  `FEE_PAYER_DEVELOPMENT_BYPASS_ENABLED=1`も指定した場合だけ利用できます。
  Mainnetでは必ず拒否します。

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

既存の`.env`を継続利用する場合は、次を明示的に追加してください。旧
`FEE_PAYER_PRIVATE_KEY`と`KAIROS_RPC_URL`は移行期間中も利用できます。

```dotenv
BLOCKCHAIN_NETWORK=kairos
```

表示された公開アドレスへKairos Faucetから必要最小限のKAIAを入れてください。
既存ユーザーWallet、Mainnet鍵、LivT Walletのmnemonicは流用しないでください。

## テスト

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

テストはHTTP fakeとoffline署名を使用し、実Kairosへbroadcastしません。
production buildの`dist/src`にはtestsと`setup-kairos`を含めません。

## Kairos手動レビュー

LivT Walletのreview runnerがLaravel、Wallet、Fee Payerをまとめて起動します。
runnerは起動ごとに内部Bearerを生成するため、外部API keyの取得や`.env`への記載は
不要です。

```bash
cd ../livt-wallet
corepack pnpm review:kairos-fee-delegated-live
```

## Mainnetについて

Phase 8のread-only構造確認コマンドは次です。Mainnet keyを読み込まず、署名・broadcastを
行わず、すべてのMainnet execution gateがfalseでkill switchがactiveの場合だけ成功します。

```bash
corepack pnpm readiness:mainnet
```

Phase 9 stagingでは、同じread-only検査に合格した場合だけlocalhost health processを起動できます。
このentry pointにはsigning routeがなく、external signerは`UNAVAILABLE`、kill switchは`ACTIVE`、
execution/signing/broadcastは`DISABLED`として報告されます。

```bash
corepack pnpm start:mainnet-staging-health
```

`FeePayerSigner`は`senderRaw`を受けて`signedRaw`を返し、addressとhealthを提供する契約です。
Kairos local signerだけが署名可能で、Mainnet external signerはPhase 9では常にunavailableです。

Mainnetでは、少なくとも次の対応が完了するまで有効化しません。

- external signerをKMS/HSMへ接続し、独立security reviewを完了
- 永続的な冪等性と結果不明transactionの復旧
- 利用上限、rate limit、監査ログ、残高監視、緊急停止
- Mainnet用chain・contract・RPC・鍵の完全分離
- transaction policyと鍵運用の独立セキュリティレビュー
