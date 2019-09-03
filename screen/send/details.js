/* global alert */
import React, { Component } from 'react';
import {
  ActivityIndicator,
  View,
  TextInput,
  Alert,
  StatusBar,
  TouchableOpacity,
  KeyboardAvoidingView,
  Keyboard,
  TouchableWithoutFeedback,
  StyleSheet,
  Platform,
  Text,
} from 'react-native';
import { Icon } from 'react-native-elements';
import AsyncStorage from '@react-native-community/async-storage';
import {
  BlueNavigationStyle,
  BlueButton,
  BlueBitcoinAmount,
  BlueAddressInput,
  BlueDismissKeyboardInputAccessory,
  BlueLoading,
  BlueUseAllFundsButton,
  BlueButtonLink,
} from '../../BlueComponents';
import Slider from '@react-native-community/slider';
import PropTypes from 'prop-types';
import Modal from 'react-native-modal';
import NetworkTransactionFees, { NetworkTransactionFee } from '../../models/networkTransactionFees';
import BitcoinBIP70TransactionDecode from '../../bip70/bip70';
import { BitcoinUnit, Chain } from '../../models/bitcoinUnits';
import { HDLegacyP2PKHWallet, HDSegwitBech32Wallet, HDSegwitP2SHWallet, LightningCustodianWallet } from '../../class';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { BitcoinTransaction } from '../../models/bitcoinTransactionInfo';
import { FlatList } from 'react-native-gesture-handler';
const bip21 = require('bip21');
let BigNumber = require('bignumber.js');
/** @type {AppStorage} */
let BlueApp = require('../../BlueApp');
let loc = require('../../loc');
let bitcoin = require('bitcoinjs-lib');

const btcAddressRx = /^[a-zA-Z0-9]{26,35}$/;

export default class SendDetails extends Component {
  static navigationOptions = ({ navigation }) => ({
    ...BlueNavigationStyle(navigation, true),
    title: loc.send.header,
  });

  constructor(props) {
    super(props);
    let addresses = [];
    let memo;
    if (props.navigation.state.params) addresses.push(new BitcoinTransaction(addresses));
    if (props.navigation.state.params) memo = props.navigation.state.params.memo;
    let fromAddress;
    if (props.navigation.state.params) fromAddress = props.navigation.state.params.fromAddress;
    let fromSecret;
    if (props.navigation.state.params) fromSecret = props.navigation.state.params.fromSecret;
    let fromWallet = null;
    if (props.navigation.state.params) fromWallet = props.navigation.state.params.fromWallet;

    if (addresses.length === 0) {
      addresses.push(new BitcoinTransaction());
    }
    const wallets = BlueApp.getWallets().filter(wallet => wallet.type !== LightningCustodianWallet.type);

    if (wallets.length === 0) {
      alert('Before creating a transaction, you must first add a Bitcoin wallet.');
      return props.navigation.goBack(null);
    } else {
      if (!fromWallet && wallets.length > 0) {
        fromWallet = wallets[0];
        fromAddress = fromWallet.getAddress();
        fromSecret = fromWallet.getSecret();
      }
      this.state = {
        isLoading: false,
        showSendMax: false,
        isFeeSelectionModalVisible: false,
        fromAddress,
        fromWallet,
        fromSecret,
        addresses,
        memo,
        fee: 1,
        networkTransactionFees: new NetworkTransactionFee(1, 1, 1),
        feeSliderValue: 1,
        bip70TransactionExpiration: null,
        renderWalletSelectionButtonHidden: false,
      };
    }
  }

  /**
   * TODO: refactor this mess, get rid of regexp, use https://github.com/bitcoinjs/bitcoinjs-lib/issues/890 etc etc
   *
   * @param data {String} Can be address or `bitcoin:xxxxxxx` uri scheme, or invalid garbage
   */
  processAddressData = data => {
    this.setState(
      { isLoading: true },
      () => {
        if (BitcoinBIP70TransactionDecode.matchesPaymentURL(data)) {
          this.processBIP70Invoice(data);
        } else {
          const dataWithoutSchema = data.replace('bitcoin:', '');
          if (btcAddressRx.test(dataWithoutSchema) || (dataWithoutSchema.indexOf('bc1') === 0 && dataWithoutSchema.indexOf('?') === -1)) {
            this.setState({
              address: dataWithoutSchema,
              bip70TransactionExpiration: null,
              isLoading: false,
            });
          } else {
            let address = '';
            let options;
            try {
              if (!data.toLowerCase().startsWith('bitcoin:')) {
                data = `bitcoin:${data}`;
              }
              const decoded = bip21.decode(data);
              address = decoded.address;
              options = decoded.options;
            } catch (error) {
              data = data.replace(/(amount)=([^&]+)/g, '').replace(/(amount)=([^&]+)&/g, '');
              const decoded = bip21.decode(data);
              decoded.options.amount = 0;
              address = decoded.address;
              options = decoded.options;
              this.setState({ isLoading: false });
            }
            console.log(options);
            if (btcAddressRx.test(address) || address.indexOf('bc1') === 0) {
              this.setState({
                address,
                amount: options.amount,
                memo: options.label || options.message,
                bip70TransactionExpiration: null,
                isLoading: false,
              });
            }
          }
        }
      },
      true,
    );
  };

  async componentDidMount() {
    console.log('send/details - componentDidMount');
    StatusBar.setBarStyle('dark-content');
    this.keyboardDidShowListener = Keyboard.addListener('keyboardDidShow', this._keyboardDidShow);
    this.keyboardDidHideListener = Keyboard.addListener('keyboardDidHide', this._keyboardDidHide);
    try {
      const cachedNetworkTransactionFees = JSON.parse(await AsyncStorage.getItem(NetworkTransactionFee.StorageKey));

      if (cachedNetworkTransactionFees && cachedNetworkTransactionFees.hasOwnProperty('halfHourFee')) {
        this.setState({
          fee: cachedNetworkTransactionFees.halfHourFee,
          networkTransactionFees: cachedNetworkTransactionFees,
          feeSliderValue: cachedNetworkTransactionFees.halfHourFee,
        });
      }
    } catch (_) {}

    let recommendedFees = await NetworkTransactionFees.recommendedFees();
    if (recommendedFees && recommendedFees.hasOwnProperty('halfHourFee')) {
      await AsyncStorage.setItem(NetworkTransactionFee.StorageKey, JSON.stringify(recommendedFees));
      this.setState({
        fee: recommendedFees.halfHourFee,
        networkTransactionFees: recommendedFees,
        feeSliderValue: recommendedFees.halfHourFee,
      });

      if (this.props.navigation.state.params.uri) {
        if (BitcoinBIP70TransactionDecode.matchesPaymentURL(this.props.navigation.state.params.uri)) {
          this.processBIP70Invoice(this.props.navigation.state.params.uri);
        } else {
          try {
            const { address, amount, memo } = this.decodeBitcoinUri(this.props.navigation.getParam('uri'));
            this.setState({ address, amount, memo, isLoading: false });
          } catch (error) {
            console.log(error);
            this.setState({ isLoading: false });
            alert('Error: Unable to decode Bitcoin address');
          }
        }
      } else {
        this.setState({ isLoading: false });
      }
    } else {
      this.setState({ isLoading: false });
    }
  }

  componentWillUnmount() {
    this.keyboardDidShowListener.remove();
    this.keyboardDidHideListener.remove();
  }

  _keyboardDidShow = () => {
    this.setState({ renderWalletSelectionButtonHidden: true });
  };

  _keyboardDidHide = () => {
    this.setState({ renderWalletSelectionButtonHidden: false });
  };

  decodeBitcoinUri(uri) {
    let amount = '';
    let parsedBitcoinUri = null;
    let address = uri || '';
    let memo = '';
    try {
      parsedBitcoinUri = bip21.decode(uri);
      address = parsedBitcoinUri.hasOwnProperty('address') ? parsedBitcoinUri.address : address;
      if (parsedBitcoinUri.hasOwnProperty('options')) {
        if (parsedBitcoinUri.options.hasOwnProperty('amount')) {
          amount = parsedBitcoinUri.options.amount.toString();
          amount = parsedBitcoinUri.options.amount;
        }
        if (parsedBitcoinUri.options.hasOwnProperty('label')) {
          memo = parsedBitcoinUri.options.label || memo;
        }
      }
    } catch (_) {}
    return { address, amount, memo };
  }

  recalculateAvailableBalance(balance, amount, fee) {
    if (!amount) amount = 0;
    if (!fee) fee = 0;
    let availableBalance;
    try {
      availableBalance = new BigNumber(balance);
      availableBalance = availableBalance.div(100000000); // sat2btc
      availableBalance = availableBalance.minus(amount);
      availableBalance = availableBalance.minus(fee);
      availableBalance = availableBalance.toString(10);
    } catch (err) {
      return balance;
    }

    return (availableBalance === 'NaN' && balance) || availableBalance;
  }

  calculateFee(utxos, txhex, utxoIsInSatoshis) {
    let index = {};
    let c = 1;
    index[0] = 0;
    for (let utxo of utxos) {
      if (!utxoIsInSatoshis) {
        utxo.amount = new BigNumber(utxo.amount).multipliedBy(100000000).toNumber();
      }
      index[c] = utxo.amount + index[c - 1];
      c++;
    }

    let tx = bitcoin.Transaction.fromHex(txhex);
    let totalInput = index[tx.ins.length];
    // ^^^ dumb way to calculate total input. we assume that signer uses utxos sequentially
    // so total input == sum of yongest used inputs (and num of used inputs is `tx.ins.length`)
    // TODO: good candidate to refactor and move to appropriate class. some day

    let totalOutput = 0;
    for (let o of tx.outs) {
      totalOutput += o.value * 1;
    }

    return new BigNumber(totalInput - totalOutput).dividedBy(100000000).toNumber();
  }

  processBIP70Invoice(text) {
    try {
      if (BitcoinBIP70TransactionDecode.matchesPaymentURL(text)) {
        this.setState(
          {
            isLoading: true,
          },
          () => {
            Keyboard.dismiss();
            BitcoinBIP70TransactionDecode.decode(text)
              .then(response => {
                let networkTransactionFees = this.state.networkTransactionFees;
                if (response.fee > networkTransactionFees.fastestFee) {
                  networkTransactionFees.fastestFee = response.fee;
                } else {
                  networkTransactionFees.halfHourFee = response.fee;
                }
                this.setState({
                  address: response.address,
                  amount: loc.formatBalanceWithoutSuffix(response.amount, BitcoinUnit.BTC, false),
                  memo: response.memo,
                  networkTransactionFees,
                  fee: networkTransactionFees.fastestFee,
                  feeSliderValue: networkTransactionFees.fastestFee,
                  bip70TransactionExpiration: response.expires,
                  isLoading: false,
                });
              })
              .catch(error => {
                alert(error.errorMessage);
                this.setState({ isLoading: false, bip70TransactionExpiration: null });
              });
          },
        );
      }
      return true;
    } catch (error) {
      this.setState({ address: text.replace(' ', ''), isLoading: false, bip70TransactionExpiration: null, amount: 0 });
      return false;
    }
  }

  async createTransaction() {
    Keyboard.dismiss();
    this.setState({ isLoading: true });
    let error = false;
    let requestedSatPerByte = this.state.fee.toString().replace(/\D/g, '');

    if (!this.state.amount || this.state.amount === '0' || parseFloat(this.state.amount) === 0) {
      error = loc.send.details.amount_field_is_not_valid;
      console.log('validation error');
    } else if (!this.state.fee || !requestedSatPerByte || parseFloat(requestedSatPerByte) < 1) {
      error = loc.send.details.fee_field_is_not_valid;
      console.log('validation error');
    } else if (!this.state.addresses) {
      error = loc.send.details.address_field_is_not_valid;
      console.log('validation error');
    } else if (this.recalculateAvailableBalance(this.state.fromWallet.getBalance(), this.state.amount, 0) < 0) {
      // first sanity check is that sending amount is not bigger than available balance
      error = loc.send.details.total_exceeds_balance;
      console.log('validation error');
    } else if (BitcoinBIP70TransactionDecode.isExpired(this.state.bip70TransactionExpiration)) {
      error = 'Transaction has expired.';
      console.log('validation error');
    } else if (this.state.address) {
      const address = this.state.address.trim().toLowerCase();
      if (address.startsWith('lnb') || address.startsWith('lightning:lnb')) {
        error =
          'This address appears to be for a Lightning invoice. Please, go to your Lightning wallet in order to make a payment for this invoice.';
        console.log('validation error');
      }
    }

    if (!error) {
      try {
        bitcoin.address.toOutputScript(this.state.address);
      } catch (err) {
        console.log('validation error');
        console.log(err);
        error = loc.send.details.address_field_is_not_valid;
      }
    }

    if (error) {
      this.setState({ isLoading: false });
      alert(error);
      ReactNativeHapticFeedback.trigger('notificationError', { ignoreAndroidSystemSettings: false });
      return;
    }

    if (this.state.fromWallet.type === HDSegwitBech32Wallet.type) {
      try {
        await this.createHDBech32Transaction();
      } catch (Err) {
        this.setState({ isLoading: false }, () => {
          alert(Err.message);
          ReactNativeHapticFeedback.trigger('notificationError', { ignoreAndroidSystemSettings: false });
        });
      }
      return;
    }

    // legacy send below

    this.setState({ isLoading: true }, async () => {
      let utxo;
      let actualSatoshiPerByte;
      let tx, txid;
      let tries = 1;
      let fee = 0.000001; // initial fee guess

      try {
        await this.state.fromWallet.fetchUtxo();
        if (this.state.fromWallet.getChangeAddressAsync) {
          await this.state.fromWallet.getChangeAddressAsync(); // to refresh internal pointer to next free address
        }
        if (this.state.fromWallet.getAddressAsync) {
          await this.state.fromWallet.getAddressAsync(); // to refresh internal pointer to next free address
        }

        utxo = this.state.fromWallet.utxo;

        do {
          console.log('try #', tries, 'fee=', fee);
          if (this.recalculateAvailableBalance(this.state.fromWallet.getBalance(), this.state.amount, fee) < 0) {
            // we could not add any fee. user is trying to send all he's got. that wont work
            throw new Error(loc.send.details.total_exceeds_balance);
          }

          let startTime = Date.now();
          tx = this.state.fromWallet.createTx(utxo, this.state.amount, fee, this.state.address, this.state.memo);
          let endTime = Date.now();
          console.log('create tx ', (endTime - startTime) / 1000, 'sec');

          let txDecoded = bitcoin.Transaction.fromHex(tx);
          txid = txDecoded.getId();
          console.log('txid', txid);
          console.log('txhex', tx);

          let feeSatoshi = new BigNumber(fee).multipliedBy(100000000);
          actualSatoshiPerByte = feeSatoshi.dividedBy(Math.round(tx.length / 2));
          actualSatoshiPerByte = actualSatoshiPerByte.toNumber();
          console.log({ satoshiPerByte: actualSatoshiPerByte });

          if (Math.round(actualSatoshiPerByte) !== requestedSatPerByte * 1 || Math.floor(actualSatoshiPerByte) < 1) {
            console.log('fee is not correct, retrying');
            fee = feeSatoshi
              .multipliedBy(requestedSatPerByte / actualSatoshiPerByte)
              .plus(10)
              .dividedBy(100000000)
              .toNumber();
          } else {
            break;
          }
        } while (tries++ < 5);

        BlueApp.tx_metadata = BlueApp.tx_metadata || {};
        BlueApp.tx_metadata[txid] = {
          txhex: tx,
          memo: this.state.memo,
        };
        await BlueApp.saveToDisk();
      } catch (err) {
        console.log(err);
        ReactNativeHapticFeedback.trigger('notificationError', { ignoreAndroidSystemSettings: false });
        alert(err);
        this.setState({ isLoading: false });
        return;
      }

      this.setState({ isLoading: false }, () =>
        this.props.navigation.navigate('Confirm', {
          amount: this.state.amount,
          // HD wallet's utxo is in sats, classic segwit wallet utxos are in btc
          fee: this.calculateFee(
            utxo,
            tx,
            this.state.fromWallet.type === HDSegwitP2SHWallet.type || this.state.fromWallet.type === HDLegacyP2PKHWallet.type,
          ),
          address: this.state.address,
          memo: this.state.memo,
          fromWallet: this.state.fromWallet,
          tx: tx,
          satoshiPerByte: actualSatoshiPerByte.toFixed(2),
        }),
      );
    });
  }

  async createHDBech32Transaction() {
    /** @type {HDSegwitBech32Wallet} */
    const wallet = this.state.fromWallet;
    await wallet.fetchUtxo();
    const changeAddress = await wallet.getChangeAddressAsync();
    let satoshis = new BigNumber(this.state.amount).multipliedBy(100000000).toNumber();
    const requestedSatPerByte = +this.state.fee.toString().replace(/\D/g, '');
    console.log({ satoshis, requestedSatPerByte, utxo: wallet.getUtxo() });

    let targets = [];
    targets.push({ address: this.state.address, value: satoshis });

    if (this.state.amount === BitcoinUnit.MAX) {
      targets = [{ address: this.state.address }];
    }

    let { tx, fee } = wallet.createTransaction(wallet.getUtxo(), targets, requestedSatPerByte, changeAddress);

    BlueApp.tx_metadata = BlueApp.tx_metadata || {};
    BlueApp.tx_metadata[tx.getId()] = {
      txhex: tx.toHex(),
      memo: this.state.memo,
    };
    await BlueApp.saveToDisk();

    this.setState({ isLoading: false }, () =>
      this.props.navigation.navigate('Confirm', {
        amount: this.state.amount,
        fee: new BigNumber(fee).dividedBy(100000000).toNumber(),
        address: this.state.address,
        memo: this.state.memo,
        fromWallet: wallet,
        tx: tx.toHex(),
        satoshiPerByte: requestedSatPerByte,
      }),
    );
  }

  onWalletSelect = wallet => {
    this.setState({ fromAddress: wallet.getAddress(), fromSecret: wallet.getSecret(), fromWallet: wallet }, () => {
      this.props.navigation.pop();
    });
  };

  renderFeeSelectionModal = () => {
    return (
      <Modal
        isVisible={this.state.isFeeSelectionModalVisible}
        style={styles.bottomModal}
        onBackdropPress={() => {
          if (this.state.fee < 1 || this.state.feeSliderValue < 1) {
            this.setState({ fee: Number(1), feeSliderValue: Number(1) });
          }
          Keyboard.dismiss();
          this.setState({ isFeeSelectionModalVisible: false });
        }}
      >
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'position' : null}>
          <View style={styles.modalContent}>
            <TouchableOpacity style={styles.satoshisTextInput} onPress={() => this.textInput.focus()}>
              <TextInput
                keyboardType="numeric"
                ref={ref => {
                  this.textInput = ref;
                }}
                value={this.state.fee.toString()}
                onEndEditing={() => {
                  if (this.state.fee < 1 || this.state.feeSliderValue < 1) {
                    this.setState({ fee: Number(1), feeSliderValue: Number(1) });
                  }
                }}
                onChangeText={value => {
                  let newValue = value.replace(/\D/g, '');
                  this.setState({ fee: newValue, feeSliderValue: Number(newValue) });
                }}
                maxLength={9}
                editable={!this.state.isLoading}
                placeholderTextColor="#37c0a1"
                placeholder={this.state.networkTransactionFees.halfHourFee.toString()}
                style={{ fontWeight: '600', color: '#37c0a1', marginBottom: 0, marginRight: 4, textAlign: 'right', fontSize: 36 }}
                inputAccessoryViewID={BlueDismissKeyboardInputAccessory.InputAccessoryViewID}
              />
              <Text
                style={{
                  fontWeight: '600',
                  color: '#37c0a1',
                  paddingRight: 4,
                  textAlign: 'left',
                  fontSize: 16,
                  alignSelf: 'flex-end',
                  marginBottom: 14,
                }}
              >
                sat/b
              </Text>
            </TouchableOpacity>
            {this.state.networkTransactionFees.fastestFee > 1 && (
              <View style={{ flex: 1, marginTop: 32, minWidth: 240, width: 240 }}>
                <Slider
                  onValueChange={value => this.setState({ feeSliderValue: value.toFixed(0), fee: value.toFixed(0) })}
                  minimumValue={1}
                  maximumValue={Number(this.state.networkTransactionFees.fastestFee)}
                  value={Number(this.state.feeSliderValue)}
                  maximumTrackTintColor="#d8d8d8"
                  minimumTrackTintColor="#37c0a1"
                  style={{ flex: 1 }}
                />
                <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 }}>
                  <Text style={{ fontWeight: '500', fontSize: 13, color: '#37c0a1' }}>slow</Text>
                  <Text style={{ fontWeight: '500', fontSize: 13, color: '#37c0a1' }}>fast</Text>
                </View>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  };

  renderCreateButton = () => {
    return (
      <View style={{ marginHorizontal: 56, marginVertical: 16, alignContent: 'center', backgroundColor: '#FFFFFF', minHeight: 44 }}>
        {this.state.isLoading ? (
          <ActivityIndicator />
        ) : (
          <BlueButton onPress={() => this.createTransaction()} title={loc.send.details.create} />
        )}
      </View>
    );
  };

  renderWalletSelectionButton = () => {
    if (this.state.renderWalletSelectionButtonHidden) return;
    return (
      <View style={{ marginBottom: 24, alignItems: 'center' }}>
        {!this.state.isLoading && (
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center' }}
            onPress={() =>
              this.props.navigation.navigate('SelectWallet', { onWalletSelect: this.onWalletSelect, chainType: Chain.ONCHAIN })
            }
          >
            <Text style={{ color: '#9aa0aa', fontSize: 14, marginRight: 8 }}>{loc.wallets.select_wallet.toLowerCase()}</Text>
            <Icon name="angle-right" size={18} type="font-awesome" color="#9aa0aa" />
          </TouchableOpacity>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 4 }}>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center' }}
            onPress={() =>
              this.props.navigation.navigate('SelectWallet', { onWalletSelect: this.onWalletSelect, chainType: Chain.ONCHAIN })
            }
          >
            <Text style={{ color: '#0c2550', fontSize: 14 }}>{this.state.fromWallet.getLabel()}</Text>
            <Text style={{ color: '#0c2550', fontSize: 14, fontWeight: '600', marginLeft: 8, marginRight: 4 }}>
              {loc.formatBalanceWithoutSuffix(this.state.fromWallet.getBalance(), BitcoinUnit.BTC, false)}
            </Text>
            <Text style={{ color: '#0c2550', fontSize: 11, fontWeight: '600', textAlignVertical: 'bottom', marginTop: 2 }}>
              {BitcoinUnit.BTC}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  renderBitcoinTransactionInfoFields = item => {
    return (
      <>
        <BlueBitcoinAmount
          isLoading={this.state.isLoading}
          amount={item.amount ? item.amount.toString() : null}
          onChangeText={text => (item.amount = text)}
          inputAccessoryViewID={this.state.fromWallet.allowSendMax() ? BlueUseAllFundsButton.InputAccessoryViewID : null}
          onFocus={() => this.setState({ isAmountToolbarVisibleForAndroid: true })}
          onBlur={() => this.setState({ isAmountToolbarVisibleForAndroid: false })}
        />
        <BlueAddressInput
          onChangeText={text => {
            if (!this.processBIP70Invoice(text)) {
              item.address = text.trim().replace('bitcoin:', '');
              this.setState({
                isLoading: false,
                bip70TransactionExpiration: null,
              });
            } else {
              try {
                const { address, amount, memo } = this.decodeBitcoinUri(text);
                item.address = address || item.address;
                item.amount = amount || item.amount;
                this.setState({
                  memo: memo || this.state.memo,
                  isLoading: false,
                  bip70TransactionExpiration: null,
                });
              } catch (_) {
                item.address = text.trim();
                this.setState({ isLoading: false, bip70TransactionExpiration: null });
              }
            }
          }}
          onBarScanned={this.processAddressData}
          address={item.address}
          isLoading={this.state.isLoading}
          inputAccessoryViewID={BlueDismissKeyboardInputAccessory.InputAccessoryViewID}
        />
      </>
    );
  };

  render() {
    if (this.state.isLoading || typeof this.state.fromWallet === 'undefined') {
      return (
        <View style={{ flex: 1, paddingTop: 20 }}>
          <BlueLoading />
        </View>
      );
    }
    return (
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={{ flex: 1, justifyContent: 'space-between' }}>
          <View>
            <KeyboardAvoidingView behavior="position">
              <FlatList
                ref={ref => (this.flatList = ref)}
                style={{ height: '45%', maxHeight: '45%' }}
                keyExtractor={(_item, index) => `${index}`}
                data={this.state.addresses}
                extraData={this.state.addresses}
                renderItem={this.renderBitcoinTransactionInfoFields}
                onContentSizeChange={() => this.flatList.scrollToEnd({animated: true})}
                onLayout={() => this.flatList.scrollToEnd({animated: true})}
               
              />
              <View
                style={{
                  height: 0.5,
                  shadowColor: '#000',
                  shadowOffset: {
                    width: 0,
                    height: 0,
                  },
                  shadowOpacity: 1,
                  shadowRadius: 1,
                  backgroundColor: '#000000',
                  elevation: 15,
                }}
              />
              <BlueButtonLink
                title="Add Recipient"
                onPress={() => {
                  const addresses = this.state.addresses;
                  addresses.push(new BitcoinTransaction());
                  this.setState(
                    {
                      addresses,
                    },
                    () => this.flatList.scrollToEnd(),
                  );
                }}
              />
              <View
                hide={!this.state.showMemoRow}
                style={{
                  flexDirection: 'row',
                  borderColor: '#d2d2d2',
                  borderBottomColor: '#d2d2d2',
                  borderWidth: 1.0,
                  borderBottomWidth: 0.5,
                  backgroundColor: '#f5f5f5',
                  minHeight: 44,
                  height: 44,
                  marginHorizontal: 20,
                  alignItems: 'center',
                  marginVertical: 8,
                  borderRadius: 4,
                }}
              >
                <TextInput
                  onChangeText={text => this.setState({ memo: text })}
                  placeholder={loc.send.details.note_placeholder}
                  value={this.state.memo}
                  numberOfLines={1}
                  style={{ flex: 1, marginHorizontal: 8, minHeight: 33 }}
                  editable={!this.state.isLoading}
                  onSubmitEditing={Keyboard.dismiss}
                  inputAccessoryViewID={BlueDismissKeyboardInputAccessory.InputAccessoryViewID}
                />
              </View>
              <TouchableOpacity
                onPress={() => this.setState({ isFeeSelectionModalVisible: true })}
                disabled={this.state.isLoading}
                style={{ flexDirection: 'row', marginHorizontal: 20, justifyContent: 'space-between', alignItems: 'center' }}
              >
                <Text style={{ color: '#81868e', fontSize: 14 }}>Fee</Text>
                <View
                  style={{
                    backgroundColor: '#d2f8d6',
                    minWidth: 40,
                    height: 25,
                    borderRadius: 4,
                    justifyContent: 'space-between',
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 10,
                  }}
                >
                  <Text style={{ color: '#37c0a1', marginBottom: 0, marginRight: 4, textAlign: 'right' }}>{this.state.fee}</Text>
                  <Text style={{ color: '#37c0a1', paddingRight: 4, textAlign: 'left' }}>sat/b</Text>
                </View>
              </TouchableOpacity>
              {this.renderCreateButton()}
              {this.renderFeeSelectionModal()}
            </KeyboardAvoidingView>
          </View>
          <BlueDismissKeyboardInputAccessory />
          {Platform.select({
            ios: (
              <BlueUseAllFundsButton
                onUseAllPressed={() => {
                  ReactNativeHapticFeedback.trigger('notificationWarning');
                  Alert.alert(
                    'Use full balance',
                    `Are you sure you want to use your wallet's full balance for this transaction?`,
                    [
                      {
                        text: loc._.ok,
                        onPress: async () => {
                          Keyboard.dismiss();
                          this.setState({ amount: BitcoinUnit.MAX });
                        },
                        style: 'default',
                      },
                      { text: loc.send.details.cancel, onPress: () => {}, style: 'cancel' },
                    ],
                    { cancelable: false },
                  );
                }}
                wallet={this.state.fromWallet}
              />
            ),
            android: this.state.isAmountToolbarVisibleForAndroid && (
              <BlueUseAllFundsButton
                onUseAllPressed={() => {
                  Alert.alert(
                    'Use all funds',
                    `Are you sure you want to use your all of your wallet's funds for this transaction?`,
                    [
                      {
                        text: loc._.ok,
                        onPress: async () => {
                          Keyboard.dismiss();
                          this.setState({ amount: BitcoinUnit.MAX });
                        },
                        style: 'default',
                      },
                      { text: loc.send.details.cancel, onPress: () => {}, style: 'cancel' },
                    ],
                    { cancelable: false },
                  );
                }}
                wallet={this.state.fromWallet}
              />
            ),
          })}

          {this.renderWalletSelectionButton()}
        </View>
      </TouchableWithoutFeedback>
    );
  }
}

const styles = StyleSheet.create({
  modalContent: {
    backgroundColor: '#FFFFFF',
    padding: 22,
    justifyContent: 'center',
    alignItems: 'center',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderColor: 'rgba(0, 0, 0, 0.1)',
    minHeight: 200,
    height: 200,
  },
  bottomModal: {
    justifyContent: 'flex-end',
    margin: 0,
  },
  satoshisTextInput: {
    backgroundColor: '#d2f8d6',
    minWidth: 127,
    height: 60,
    borderRadius: 8,
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
});

SendDetails.propTypes = {
  navigation: PropTypes.shape({
    pop: PropTypes.func,
    goBack: PropTypes.func,
    navigate: PropTypes.func,
    getParam: PropTypes.func,
    state: PropTypes.shape({
      params: PropTypes.shape({
        amount: PropTypes.number,
        address: PropTypes.string,
        fromAddress: PropTypes.string,
        satoshiPerByte: PropTypes.string,
        fromSecret: PropTypes.fromSecret,
        fromWallet: PropTypes.fromWallet,
        memo: PropTypes.string,
        uri: PropTypes.string,
      }),
    }),
  }),
};
