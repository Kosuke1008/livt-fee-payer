# LivT Fee Payer

LivTのJPYC決済手数料を負担する、セルフホスト型のFee Payerサービスです。

LivT Walletがブラウザ内で署名したtransactionへFee Payer署名を追加し、Kaia
Kairosへbroadcastします。Kaia Managed Fee DelegationはLaravel側の将来選択肢として
残しますが、このserviceから自動fallbackしません。

> Mainnet向けAWS KMS signerは検証可能ですが、Mainnet実行はcode-level gateで無効です。

ネットワークはapplication環境から推測せず、`BLOCKCHAIN_NETWORK=kairos`で
明示します。`kaia-mainnet` profileもchain ID 8217、JPYC、explorer、RPCの
検証用metadataとして存在します。Phase 9.5ではKMS metadata healthと明示的offline署名だけを提供し、
Mainnet payment pathのexecution/signing/broadcast policyはcode上でfalseです。

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
- Kairos local signerだけがprocess秘密鍵を利用します。MainnetはAWS KMSにdigest署名を要求し、
  process local keyを拒否します。KMS公開鍵からaddressを導出し、DER署名をrecover検証します。
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

Phase 11のreadinessコマンドは次です。Mainnet private keyを読み込まず、署名・broadcastを
行わず、すべてのMainnet execution gateがfalseでkill switchがactiveの場合だけ成功します。

```bash
corepack pnpm readiness:mainnet
```

Mainnet残高を照会できれば、minimum reserve未満でもread-only readinessは成功し、
`funding_status=NOT_FUNDED`として現在残高とminimum reserveを明示します。reserve以上なら
`funding_status=FUNDED`です。これは実行許可ではなく、Phase 12のsponsorshipは従来どおり
reserve未満を署名前に拒否します。

未入金環境では、公開値部分が次の形になります。

```text
balance_wei=0
balance_kaia=0
minimum_reserve_wei=<configured reserve in wei>
minimum_reserve_kaia=<configured reserve in KAIA>
funding_status=NOT_FUNDED
execution=disabled
signing=disabled
broadcast=disabled
readiness=READ_ONLY_READY
```

Phase 11 stagingでは、同じread-only検査とKMS metadata healthをlocalhostから監視できます。
このentry pointにはsigning routeがなく、healthyならexternal signerは`SIGNER_READY`、kill switchは`ACTIVE`、
execution/signing/broadcastは`DISABLED`として報告されます。

```bash
corepack pnpm start:mainnet-staging-health
```

`FeePayerSigner`は`senderRaw`を受けて`signedRaw`を返し、address/type/safe metadata/healthを提供します。
実KMSへ固定test digestの署名を1回だけ要求し、recover検証する明示的なoffline commandは次です。

```bash
corepack pnpm signer:test-mainnet
```

このcommandはPayment、RPC、broadcastを使いません。運用詳細はplatform repositoryの
`docs/external-signer-runbook.md`を参照してください。

Mainnetでは、少なくとも次の対応が完了するまで有効化しません。

- 実AWS KMS key/IAMを構築し、offline proofと独立security reviewを完了
- 永続的な冪等性と結果不明transactionの復旧
- 利用上限、rate limit、監査ログ、残高監視、緊急停止
- Mainnet用chain・contract・RPC・鍵の完全分離
- transaction policyと鍵運用の独立セキュリティレビュー
