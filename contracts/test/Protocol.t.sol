// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AtomicProxy} from '../src/AtomicProxy.sol';
import {Protocol} from '../src/Protocol.sol';
import {Settlement} from '../src/Settlement.sol';
import {StellariumBalanceVault} from '../src/StellariumBalanceVault.sol';
import {ResourceRegistry} from '../src/ResourceRegistry.sol';
import {RelayRegistry} from '../src/RelayRegistry.sol';
import {ReputationRegistry} from '../src/ReputationRegistry.sol';
import {FeeOracle} from '../src/FeeOracle.sol';
import {ProtocolTreasury} from '../src/ProtocolTreasury.sol';
import {ArbitrationCourt} from '../src/ArbitrationCourt.sol';
import {RandomnessAdapter} from '../src/RandomnessAdapter.sol';
import {TimelockController} from '../src/TimelockController.sol';
import {Governor} from '../src/Governor.sol';
import {StewardMultisig} from '../src/StewardMultisig.sol';
import {DeploymentFactory} from '../src/DeploymentFactory.sol';
import {MockUSDC,MockFeed,MockGasOracle,MockVRF} from './Mocks.sol';
interface Vm {
    function addr(uint256) external returns(address);
    function sign(uint256,bytes32) external returns(uint8,bytes32,bytes32);
    function prank(address) external; function startPrank(address) external; function stopPrank() external;
    function warp(uint256) external; function chainId(uint256) external;
    function expectRevert() external; function expectRevert(bytes calldata) external;
    function txGasPrice(uint256) external;
}
contract ProtocolTest {
    Vm private constant vm=Vm(address(uint160(uint256(keccak256('hevm cheat code')))));
    MockUSDC token; MockFeed feed; MockGasOracle gasOracle; MockVRF vrf;
    Settlement settlement; StellariumBalanceVault vault; ResourceRegistry registry; RelayRegistry relays;
    ReputationRegistry reputation; FeeOracle fees; ProtocolTreasury treasury; ArbitrationCourt court; RandomnessAdapter randomness;
    TimelockController timelock; Governor governor; StewardMultisig multisig;
    address caller; address provider; address relay; address authority;
    bytes32 constant RESOURCE=keccak256('example.Weather'); bytes32 constant QUOTE=keccak256('quote1');
    uint256 constant PRICE=1_000_000;
    function _proxy(address implementation) private returns(address) { AtomicProxy proxy=new AtomicProxy(implementation); proxy.finalizeInitialization(); return address(proxy); }
    function setUp() public {
        vm.chainId(84532); vm.warp(1_000_000); caller=vm.addr(1); provider=vm.addr(2); relay=vm.addr(3); authority=vm.addr(4);
        token=new MockUSDC(); feed=new MockFeed(); gasOracle=new MockGasOracle(); vrf=new MockVRF();
        settlement=Settlement(_proxy(address(new Settlement()))); vault=StellariumBalanceVault(_proxy(address(new StellariumBalanceVault())));
        registry=ResourceRegistry(_proxy(address(new ResourceRegistry()))); relays=RelayRegistry(_proxy(address(new RelayRegistry())));
        reputation=ReputationRegistry(_proxy(address(new ReputationRegistry()))); fees=FeeOracle(_proxy(address(new FeeOracle())));
        treasury=ProtocolTreasury(_proxy(address(new ProtocolTreasury()))); court=ArbitrationCourt(_proxy(address(new ArbitrationCourt())));
        randomness=RandomnessAdapter(_proxy(address(new RandomnessAdapter()))); timelock=TimelockController(payable(_proxy(address(new TimelockController()))));
        governor=Governor(_proxy(address(new Governor()))); multisig=StewardMultisig(payable(_proxy(address(new StewardMultisig()))));
        address[] memory seeds=new address[](19); seeds[0]=caller; seeds[1]=provider; seeds[2]=relay; seeds[3]=authority;
        for(uint256 i;i<15;++i) seeds[i+4]=vm.addr(100+i);
        uint256[6] memory coefficients=[uint256(1),uint256(1),uint256(1),uint256(1),uint256(1),uint256(100)];
        reputation.initialize(address(this),seeds,coefficients);
        vault.initialize(address(this),address(token),address(settlement),address(court),address(multisig));
        registry.initialize(address(this),address(token),address(reputation),address(court));
        relays.initialize(address(this),address(token),address(reputation),address(court),1_000_000);
        fees.initialize(address(this),address(feed),address(gasOracle),100_000,128,200 gwei);
        treasury.initialize(address(this),address(vault),address(token),address(settlement),address(court));
        court.initialize(address(this),address(token),address(reputation),address(treasury),address(settlement),address(randomness),1_000_000,1_000_000);
        randomness.initialize(address(this),address(vrf),address(court),bytes32(uint256(1)),1,3,300_000);
        settlement.initialize(address(this),address(vault),address(registry),address(relays),address(reputation),address(fees),address(treasury),address(court),address(multisig));
        reputation.setReporter(address(settlement),true); reputation.setReporter(address(court),true);
        this.publish(1,QUOTE,provider);
        token.mint(caller,100_000_000); token.mint(provider,100_000_000); token.mint(relay,100_000_000); token.mint(address(this),100_000_000);
        vm.startPrank(caller); token.approve(address(vault),type(uint256).max); token.approve(address(court),type(uint256).max); vault.deposit(50_000_000); vm.stopPrank();
        vm.startPrank(provider); token.approve(address(court),type(uint256).max); vm.stopPrank();
        vm.startPrank(relay); token.approve(address(relays),type(uint256).max); relays.stake(1_000_000); vm.stopPrank();
        token.approve(address(treasury),type(uint256).max); treasury.fundReserve(50_000_000);
        for(uint256 i;i<15;++i) { address arb=seeds[i+4]; token.mint(arb,1_000_000); vm.startPrank(arb); token.approve(address(court),type(uint256).max); court.stake(1_000_000,'public-key'); vm.stopPrank(); }
    }
    function _signature(uint256 key,bytes32 digest) private returns(bytes memory) { (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,digest); return abi.encodePacked(r,s,v); }
    function publish(uint256 number,bytes32 quote,address signer) external {
        Protocol.FunctionQuote[] memory functions=new Protocol.FunctionQuote[](1); functions[0]=Protocol.FunctionQuote('forecast',PRICE,quote);
        Protocol.MonetizationManifest memory m=Protocol.MonetizationManifest(1,RESOURCE,number,provider,provider,signer,'public-key',address(token),keccak256(abi.encode(number)),functions,uint64(block.timestamp));
        registry.publishManifest(m,_signature(2,registry.domainHash(Protocol.hash(m))),'{}');
    }
    function makeClaim(uint256 nonce,bool accepted) external returns(Protocol.Claim memory c) {
        c.authorization=Protocol.RequestAuthorization(1,keccak256(abi.encode('request',nonce)),caller,10_000_000,keccak256('source'),authority,uint64(block.timestamp),uint64(block.timestamp+1 days),nonce);
        c.callerSignature=_signature(1,settlement.domainHash(Protocol.hash(c.authorization)));
        vm.prank(caller); vault.openRequestBudget(c.authorization,c.callerSignature);
        c.grant=Protocol.InvocationGrant(1,c.authorization.requestId,settlement.domainHash(Protocol.hash(c.authorization)),keccak256(abi.encode('invocation',nonce)),provider,RESOURCE,1,keccak256('forecast'),keccak256('parameters'),QUOTE,PRICE,uint64(block.timestamp),c.authorization.expiresAt);
        c.authoritySignature=_signature(4,settlement.domainHash(Protocol.hash(c.grant)));
        bytes32 id=settlement.domainHash(Protocol.hash(c.grant));
        c.receipt.protocolVersion=1;
        c.receipt.receiptId=keccak256(abi.encode(block.chainid,address(settlement),c.authorization.requestId,id));
        c.receipt.requestId=c.authorization.requestId; c.receipt.authorizationHash=c.grant.authorizationHash;
        c.receipt.invocationId=id; c.receipt.invocationGrantHash=id; c.receipt.manifestRevision=1;
        c.receipt.providerPaymentIdentity=provider; c.receipt.paymentRecipient=provider; c.receipt.receiptSigner=provider;
        c.receipt.resourceId=RESOURCE; c.receipt.functionNameHash=c.grant.functionNameHash; c.receipt.parametersHash=c.grant.parametersHash;
        c.receipt.responseHash=keccak256('result'); c.receipt.quoteId=QUOTE; c.receipt.grossPriceUsdc=PRICE;
        c.receipt.relay=relay; c.receipt.relayFeeUsdc=100_000; c.receipt.executedAt=uint64(block.timestamp); c.receipt.issuedAt=uint64(block.timestamp);
        c.providerSignature=_signature(2,settlement.domainHash(Protocol.hash(c.receipt)));
        if(accepted) { c.acceptance=Protocol.Acceptance(1,settlement.domainHash(Protocol.hash(c.receipt)),uint64(block.timestamp)); c.acceptanceSignature=_signature(1,settlement.domainHash(Protocol.hash(c.acceptance))); }
    }
    function submit(Protocol.Claim memory c) external { Protocol.Claim[] memory batch=new Protocol.Claim[](1); batch[0]=c; vm.prank(relay); settlement.submitBatch(batch); }
    function _state(bytes32 id) private view returns(uint8 state) { (,,,,,,,,,state,)=settlement.claims(id); }
    function testFallbackLocksFundsForOneHour() public { Protocol.Claim memory c=this.makeClaim(0,false); this.submit(c); require(vault.available(provider)==0,'early payment'); vm.expectRevert(); settlement.finalize(c.receipt.receiptId); vm.warp(block.timestamp+1 hours); settlement.finalize(c.receipt.receiptId); require(vault.available(provider)==900_000&&vault.available(relay)==100_000,'payment'); }
    function testAcceptanceUsesSameChallengeWindow() public { Protocol.Claim memory c=this.makeClaim(0,true); this.submit(c); vm.expectRevert(); settlement.finalize(c.receipt.receiptId); vm.warp(block.timestamp+1 hours); settlement.finalize(c.receipt.receiptId); require(_state(c.receipt.receiptId)==3,'paid'); }
    function testQuotesAreReusable() public { this.submit(this.makeClaim(0,false)); this.submit(this.makeClaim(1,false)); }
    function testQuoteHasNoAgeExpiry() public { vm.warp(block.timestamp+30 days); feed.set(2000e8,block.timestamp); this.submit(this.makeClaim(0,false)); }
    function testDuplicateReceiptIsRejected() public { Protocol.Claim memory c=this.makeClaim(0,false); this.submit(c); vm.expectRevert(); this.submit(c); }
    function testNonceCannotOpenAnotherBudget() public { Protocol.Claim memory c=this.makeClaim(0,false); c.authorization.requestId=keccak256('another request'); c.callerSignature=_signature(1,settlement.domainHash(Protocol.hash(c.authorization))); vm.prank(caller); vm.expectRevert(); vault.openRequestBudget(c.authorization,c.callerSignature); }
    function testWrongRelayRejected() public { Protocol.Claim memory c=this.makeClaim(0,false); Protocol.Claim[] memory batch=new Protocol.Claim[](1); batch[0]=c; vm.prank(provider); vm.expectRevert(); settlement.submitBatch(batch); }
    function testProviderCannotIssueGrant() public { Protocol.Claim memory c=this.makeClaim(0,false); c.authoritySignature=_signature(2,settlement.domainHash(Protocol.hash(c.grant))); vm.expectRevert(); this.submit(c); }
    function testWrongPriceRejected() public { Protocol.Claim memory c=this.makeClaim(0,false); c.receipt.grossPriceUsdc++; c.providerSignature=_signature(2,settlement.domainHash(Protocol.hash(c.receipt))); vm.expectRevert(); this.submit(c); }
    function testHistoricalSignerSurvivesRotation() public { Protocol.Claim memory c=this.makeClaim(0,false); vm.warp(block.timestamp+1); this.publish(2,keccak256('quote2'),authority); this.submit(c); }
    function testRetiredQuoteCannotExecuteLater() public { Protocol.Claim memory c=this.makeClaim(0,false); vm.warp(block.timestamp+1); this.publish(2,keccak256('quote2'),authority); c.receipt.executedAt=uint64(block.timestamp); c.receipt.issuedAt=uint64(block.timestamp); c.providerSignature=_signature(2,settlement.domainHash(Protocol.hash(c.receipt))); vm.expectRevert(); this.submit(c); }
    function testFutureExecutionRejected() public { Protocol.Claim memory c=this.makeClaim(0,false); c.receipt.executedAt=uint64(block.timestamp+1); c.providerSignature=_signature(2,settlement.domainHash(Protocol.hash(c.receipt))); vm.expectRevert(); this.submit(c); }
    function testSubmissionDeadlineEnforced() public { Protocol.Claim memory c=this.makeClaim(0,false); vm.warp(block.timestamp+1801); feed.set(2000e8,block.timestamp); vm.expectRevert(); this.submit(c); }
    function testStaleOracleRejectsBatch() public { Protocol.Claim memory c=this.makeClaim(0,false); feed.set(2000e8,block.timestamp-901); vm.expectRevert(); this.submit(c); }
    function testFeeCapPreservesGrossConservation() public { gasOracle.setFee(1 ether); Protocol.Claim memory c=this.makeClaim(0,false); this.submit(c); vm.warp(block.timestamp+1 hours); settlement.finalize(c.receipt.receiptId); require(vault.available(provider)==0,'zero net'); require(vault.available(relay)+vault.available(address(treasury))==PRICE,'gross conservation'); }
    function testInvalidClaimDoesNotStallValidBatch() public { Protocol.Claim memory bad=this.makeClaim(0,false); Protocol.Claim memory good=this.makeClaim(1,false); bad.providerSignature=hex'00'; Protocol.Claim[] memory batch=new Protocol.Claim[](2); batch[0]=bad; batch[1]=good; vm.prank(relay); settlement.submitBatch(batch); require(_state(good.receipt.receiptId)==1&&_state(bad.receipt.receiptId)==0,'batch isolation'); }
    function testClosedBudgetRejectsNewClaims() public { Protocol.Claim memory c=this.makeClaim(0,false); vm.prank(caller); vault.closeRequest(c.authorization.requestId); vm.expectRevert(); this.submit(c); }
    function testClosingBudgetPreservesLockedClaim() public { Protocol.Claim memory c=this.makeClaim(0,false); this.submit(c); vm.prank(caller); vault.closeRequest(c.authorization.requestId); vm.warp(block.timestamp+1 hours); settlement.finalize(c.receipt.receiptId); require(vault.available(provider)==900_000,'pending claim preserved'); }
    function testEmergencyPauseDoesNotBlockWithdrawal() public { vm.prank(address(multisig)); vault.emergencyPause(); vm.prank(caller); vault.withdraw(1_000_000); vm.prank(caller); vm.expectRevert(); vault.deposit(1); vm.prank(address(multisig)); vm.expectRevert(); vault.emergencyPause(); }
    function _challenge(Protocol.Claim memory c) private { this.submit(c); vm.prank(caller); settlement.challenge(c.receipt.receiptId); vrf.fulfill(randomness,vrf.lastRequest(),123); }
    function testMissingProviderEvidenceDefaultsToCallerAndRecordsDebt() public {
        Protocol.Claim memory c=this.makeClaim(0,false); _challenge(c); vm.prank(caller); court.commitEvidence(c.receipt.receiptId,keccak256('evidence'));
        ArbitrationCourt.Round memory r=court.getRound(c.receipt.receiptId,0); vm.warp(r.evidenceUntil+1); court.decide(c.receipt.receiptId); vm.warp(block.timestamp+1 days); court.finalize(c.receipt.receiptId);
        require(_state(c.receipt.receiptId)==4&&court.feeDebt(provider)==1_000_000&&court.withdrawable(caller)==1_000_000,'default and fees');
        vm.prank(provider); court.repayFeeDebt(1_000_000); require(court.feeDebt(provider)==0,'debt cleared');
    }
    function testMajorityAndAllAppealPanels() public {
        Protocol.Claim memory c=this.makeClaim(0,false); _challenge(c); vm.prank(provider); court.depositFee(c.receipt.receiptId);
        for(uint8 round;round<3;++round) {
            vm.prank(caller); court.commitEvidence(c.receipt.receiptId,keccak256('caller evidence')); vm.prank(provider); court.commitEvidence(c.receipt.receiptId,keccak256('provider evidence'));
            ArbitrationCourt.Round memory r=court.getRound(c.receipt.receiptId,round); require(r.panel.length==(round==0?3:round==1?5:7),'panel size');
            vm.warp(r.evidenceUntil+1); for(uint256 i;i<r.panel.length;++i) { vm.prank(r.panel[i]); court.vote(c.receipt.receiptId,true); }
            court.decide(c.receipt.receiptId);
            if(round<2) { vm.prank(caller); court.appeal(c.receipt.receiptId); vrf.fulfill(randomness,vrf.lastRequest(),100+round); }
        }
        vm.prank(caller); vm.expectRevert(); court.appeal(c.receipt.receiptId);
        vm.warp(block.timestamp+1 days); court.finalize(c.receipt.receiptId); require(_state(c.receipt.receiptId)==3,'provider wins');
    }
    function testUnauthenticatedRandomnessRejected() public { vm.expectRevert(); court.randomnessReady(bytes32(uint256(1)),42); }
    function testUnselectedArbitratorCannotVote() public { Protocol.Claim memory c=this.makeClaim(0,false); _challenge(c); ArbitrationCourt.Round memory r=court.getRound(c.receipt.receiptId,0); vm.warp(r.evidenceUntil+1); vm.prank(caller); vm.expectRevert(); court.vote(c.receipt.receiptId,true); }
    function testProxyCannotInitializeTwice() public { vm.expectRevert(); vault.initialize(address(this),address(token),address(settlement),address(court),address(multisig)); }
    function testImplementationCannotInitialize() public { StellariumBalanceVault implementation=new StellariumBalanceVault(); vm.expectRevert(); implementation.initialize(address(this),address(token),address(settlement),address(court),address(multisig)); }
    function testUnauthorizedUpgradeRejected() public { address next=address(new StellariumBalanceVault()); vm.prank(caller); vm.expectRevert(); vault.upgradeToAndCall(next,''); }
    function testTimelockEnforcesUpgradeAndOrdinaryDelays() public {
        timelock.initialize(address(this)); bytes memory upgrade=abi.encodeWithSignature('upgradeToAndCall(address,bytes)',address(vault),bytes(''));
        vm.expectRevert(); timelock.schedule(address(vault),0,upgrade,bytes32(0),bytes32(0),48 hours);
        timelock.schedule(address(vault),0,upgrade,bytes32(0),bytes32(0),7 days);
        vm.expectRevert(); timelock.schedule(address(vault),0,abi.encodeWithSignature('setGuardian(address)',caller),bytes32(0),bytes32(uint256(1)),1 hours);
    }
    function testChallengeWaitsForAvailableArbitrators() public {
        vm.prank(vm.addr(100)); court.unstake(1_000_000);
        Protocol.Claim memory c=this.makeClaim(0,false);this.submit(c);vm.prank(caller);settlement.challenge(c.receipt.receiptId);
        require(_state(c.receipt.receiptId)==2,'claim frozen');
        vm.startPrank(vm.addr(100));court.stake(1_000_000,'public-key');vm.stopPrank();court.requestPanel(c.receipt.receiptId);
        vrf.fulfill(randomness,vrf.lastRequest(),99);require(court.getRound(c.receipt.receiptId,0).panel.length==3,'panel recovered');
    }
    function testSponsorRequiresDistinctSignersAndRollingQuota() public {
        address candidate=vm.addr(500);vm.prank(caller);reputation.sponsor(candidate);vm.prank(caller);vm.expectRevert();reputation.sponsor(candidate);
        vm.prank(provider);reputation.sponsor(candidate);require(!reputation.admitted(candidate),'requires third sponsor');vm.prank(relay);reputation.sponsor(candidate);require(reputation.admitted(candidate),'admitted');
        vm.startPrank(caller);reputation.sponsor(vm.addr(501));reputation.sponsor(vm.addr(502));vm.expectRevert();reputation.sponsor(vm.addr(503));vm.stopPrank();
    }
    function testStewardRequiresThreeDistinctSignaturesAndRejectsReplay() public {
        address[5] memory owners;for(uint256 i;i<5;++i) owners[i]=vm.addr(500+i);
        multisig.initialize(address(timelock),owners,address(vault),address(settlement));bytes memory data=abi.encodeWithSignature('emergencyPause()');
        bytes32 digest=multisig.domainHash(keccak256(abi.encode(keccak256('StewardAction(uint32 protocolVersion,address target,uint256 value,bytes32 dataHash,uint64 issuedAt,uint64 expiresAt,uint256 nonce)'),uint32(1),address(vault),uint256(0),keccak256(data),uint64(block.timestamp),uint64(block.timestamp+1 hours),uint256(0))));
        uint256[3] memory keys=[uint256(500),uint256(501),uint256(502)];for(uint256 i;i<3;++i) for(uint256 j=i+1;j<3;++j) if(vm.addr(keys[j])<vm.addr(keys[i])) {uint256 temp=keys[i];keys[i]=keys[j];keys[j]=temp;}
        bytes[] memory signatures=new bytes[](3);for(uint256 i;i<3;++i) signatures[i]=_signature(keys[i],digest);
        bytes[] memory two=new bytes[](2);two[0]=signatures[0];two[1]=signatures[1];vm.expectRevert();multisig.execute(address(vault),0,data,uint64(block.timestamp),uint64(block.timestamp+1 hours),two);
        multisig.execute(address(vault),0,data,uint64(block.timestamp),uint64(block.timestamp+1 hours),signatures);require(multisig.nonce()==1,'nonce');vm.expectRevert();multisig.execute(address(vault),0,data,uint64(block.timestamp),uint64(block.timestamp+1 hours),signatures);
    }
    function testReputationGovernorTransitionsAndExecutesThroughTimelock() public {
        address[] memory seeds=new address[](100);for(uint256 i;i<100;++i) seeds[i]=vm.addr(1000+i);
        ReputationRegistry rep=ReputationRegistry(_proxy(address(new ReputationRegistry())));uint256[6] memory params=[uint256(1),uint256(1),uint256(1),uint256(1),uint256(1),uint256(100)];rep.initialize(address(this),seeds,params);rep.setReporter(address(this),true);
        for(uint256 i;i<100;++i) rep.recordSettlement(bytes32(i),seeds[i],seeds[i],seeds[i],true);
        timelock.initialize(address(multisig));governor.initialize(address(this),address(rep),address(timelock),address(multisig),1 days,1 days,2000);
        vm.expectRevert();governor.activate();vm.startPrank(address(timelock));timelock.grantRole(timelock.PROPOSER_ROLE(),address(governor));timelock.revokeRole(timelock.PROPOSER_ROLE(),address(multisig));timelock.revokeRole(timelock.CANCELLER_ROLE(),address(multisig));vm.stopPrank();governor.activate();
        vault.transferOwnership(address(timelock));address[] memory targets=new address[](1);targets[0]=address(vault);uint256[] memory values=new uint256[](1);bytes[] memory calls=new bytes[](1);calls[0]=abi.encodeWithSignature('setGuardian(address)',caller);
        vm.prank(seeds[0]);bytes32 id=governor.propose(targets,values,calls,keccak256('guardian'));vm.warp(block.timestamp+1 days+1);
        for(uint256 i;i<100;++i) {vm.prank(seeds[i]);governor.vote(id,true);}vm.warp(governor.getProposal(id).deadline+1);governor.queue(id);vm.expectRevert();governor.execute(id);vm.warp(governor.getProposal(id).deadline+1+48 hours);governor.execute(id);require(vault.guardian()==caller,'governance executed');
    }
    function testFactoryRollsBackFailedAtomicInitialization() public {
        DeploymentFactory factory=new DeploymentFactory();address[] memory implementations=new address[](1);implementations[0]=address(new StellariumBalanceVault());bytes32[] memory salts=new bytes32[](1);salts[0]=keccak256('atomic');bytes[] memory initializers=new bytes[](1);initializers[0]=hex'ffffffff';
        address predicted=factory.predict(implementations[0],salts[0]);vm.expectRevert();factory.deploy(implementations,salts,initializers);require(predicted.code.length==0,'no uninitialized proxy');
        initializers[0]=abi.encodeWithSelector(StellariumBalanceVault.initialize.selector,address(this),address(token),address(settlement),address(court),address(multisig));factory.deploy(implementations,salts,initializers);require(StellariumBalanceVault(predicted).owner()==address(this),'initialized');
    }
    function nextInvocation(Protocol.Claim memory c,uint256 nonce) external returns(Protocol.Claim memory) {
        c.grant.invocationNonce=bytes32(nonce);bytes32 id=settlement.domainHash(Protocol.hash(c.grant));c.authoritySignature=_signature(4,id);c.receipt.invocationId=id;c.receipt.invocationGrantHash=id;c.receipt.receiptId=keccak256(abi.encode(block.chainid,address(settlement),c.authorization.requestId,id));c.providerSignature=_signature(2,settlement.domainHash(Protocol.hash(c.receipt)));return c;
    }
    function testDirectCallsShareOneBudgetAndCannotOverspend() public {
        Protocol.Claim memory c=this.makeClaim(0,false);this.submit(c);
        for(uint256 i=1;i<10;++i) this.submit(this.nextInvocation(c,i));
        (,,uint256 remaining,,)=vault.budgets(c.authorization.requestId);require(remaining==0,'budget consumed');Protocol.Claim memory excess=this.nextInvocation(c,10);vm.expectRevert();this.submit(excess);require(vault.available(caller)==40_000_000,'bounded reservation');
    }
    function testDepletedReserveCannotBlockChallengeButRequiresReplenishment() public {
        treasury.spendReserve(address(this),50_000_000);Protocol.Claim memory c=this.makeClaim(0,false);_challenge(c);vm.prank(caller);court.commitEvidence(c.receipt.receiptId,keccak256('caller evidence'));
        ArbitrationCourt.Round memory r=court.getRound(c.receipt.receiptId,0);vm.warp(r.evidenceUntil+1);court.decide(c.receipt.receiptId);vm.warp(r.evidenceUntil+1+1 days);
        vm.expectRevert();court.finalize(c.receipt.receiptId);treasury.fundReserve(1_000_000);court.finalize(c.receipt.receiptId);require(_state(c.receipt.receiptId)==4&&court.feeDebt(provider)==1_000_000,'replenished resolution');
        vm.expectRevert();this.publish(2,keccak256('debt quote'),provider);
        vm.prank(provider);vm.expectRevert();relays.stake(1);
    }
    function testFuzzWithdrawConservesBalance(uint64 amount) public { uint256 withdrawal=uint256(amount)%50_000_001; uint256 before=token.balanceOf(caller); vm.prank(caller); vault.withdraw(withdrawal); require(vault.available(caller)+withdrawal==50_000_000&&token.balanceOf(caller)==before+withdrawal,'conservation'); }
}
