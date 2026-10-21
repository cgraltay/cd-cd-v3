@IsTest
private class ATest {
  @IsTest
  static void constructorQueriesAccount() {
    System.runAs(accountReader()) {
      Account expectedAccount = new Account(Name = 'A Test Account');
      insert expectedAccount;

      Test.startTest();
      A instance = new A();
      Test.stopTest();

      Assert.isNotNull(instance.account, 'The account should be queried.');
      Assert.areEqual(expectedAccount.Id, instance.account.Id);
      Assert.areEqual(expectedAccount.Name, instance.account.Name);
    }
  }

  @IsTest
  static void constructorHandlesNoAccounts() {
    System.runAs(accountReader()) {
      Test.startTest();
      A instance = new A();
      Test.stopTest();

      Assert.isNull(instance.account, 'No account should be returned.');
    }
  }

  private static User accountReader() {
    return new User(
      Alias = 'atest',
      Email = 'atest@example.invalid',
      EmailEncodingKey = 'UTF-8',
      LastName = 'A Test',
      LanguageLocaleKey = 'en_US',
      LocaleSidKey = 'en_US',
      ProfileId = [
        SELECT Id
        FROM Profile
        WHERE Name = 'System Administrator'
        LIMIT 1
      ]
      .Id,
      TimeZoneSidKey = 'GMT',
      Username = 'atest.' +
        UserInfo.getOrganizationId() +
        '.' +
        String.valueOf(Crypto.getRandomLong()) +
        '@example.invalid'
    );
  }
}
