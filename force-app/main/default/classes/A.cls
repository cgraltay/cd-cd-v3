/**
 * @description This is class A.
 */
public with sharing class A {
  public Account account { get; private set; }

  /**
   * @description Constructor for class A.
   */
  public A() {
    List<Account> accounts = [
      SELECT Id, Name
      FROM Account
      WITH USER_MODE
      LIMIT 1
    ];
    account = accounts.isEmpty() ? null : accounts[0];
  }
}
